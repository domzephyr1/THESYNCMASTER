import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { EnhancedSyncSegment, VideoClip } from '../types';

export class RenderService {
  private ffmpeg: FFmpeg | null = null;
  private loaded: boolean = false;
  // Cache blob URLs to avoid re-fetching
  private coreURL: string | null = null;
  private wasmURL: string | null = null;

  async load() {
    if (this.loaded && this.ffmpeg) return;

    // Terminate existing instance if any
    if (this.ffmpeg) {
      try {
        this.ffmpeg.terminate();
      } catch {}
    }

    this.ffmpeg = new FFmpeg();
    this.loaded = false;

    // Log FFmpeg output for debugging
    this.ffmpeg.on('log', ({ message }) => {
      console.log('[FFmpeg]', message);
    });

    const baseURL = '/ffmpeg';

    try {
        // Cache blob URLs for faster reloads
        if (!this.coreURL) {
          this.coreURL = await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript');
        }
        if (!this.wasmURL) {
          this.wasmURL = await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm');
        }

        await this.ffmpeg.load({
            coreURL: this.coreURL,
            wasmURL: this.wasmURL,
        });
        this.loaded = true;
        console.log("✅ FFmpeg loaded successfully");
    } catch (e) {
        console.error("Failed to load FFmpeg", e);
        throw new Error("FFmpeg failed to initialize. Try using 'Quick Record' option instead.");
    }
  }

  // Force reload FFmpeg to clear all WASM memory
  async reload() {
    console.log("🔄 Reloading FFmpeg to clear WASM memory...");
    if (this.ffmpeg) {
      try {
        this.ffmpeg.terminate();
      } catch {}
    }
    this.ffmpeg = null;
    this.loaded = false;
    // Small delay to allow garbage collection
    await new Promise(r => setTimeout(r, 100));
    await this.load();
  }

  async exportVideo(
    audioFile: File,
    segments: EnhancedSyncSegment[],
    videoClips: VideoClip[],
    onProgress: (progress: number) => void
  ): Promise<Blob> {
    console.log("🎬 Starting FFmpeg Render (Memory-Safe Mode)...");
    console.log(`   Audio: ${audioFile.name} (${(audioFile.size / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`   Segments: ${segments.length}`);
    console.log(`   Clips: ${videoClips.length}`);

    // Validate inputs
    if (!segments || segments.length === 0) {
      throw new Error('No segments to render. Please generate sync first.');
    }
    if (!videoClips || videoClips.length === 0) {
      throw new Error('No video clips available.');
    }
    if (!audioFile) {
      throw new Error('No audio file available.');
    }

    // Check if clips have file data
    const clipsWithFiles = videoClips.filter(c => c.file || c.url);
    console.log(`   Clips with file data: ${clipsWithFiles.length}/${videoClips.length}`);

    if (clipsWithFiles.length === 0) {
      throw new Error('Video clips are missing file data. Please re-upload videos.');
    }

    // Validate all segment videoIndices are within bounds
    const invalidSegments = segments.filter(s => s.videoIndex < 0 || s.videoIndex >= videoClips.length);
    if (invalidSegments.length > 0) {
      console.error(`❌ Found ${invalidSegments.length} segments with invalid videoIndex:`, invalidSegments);
      throw new Error(`Some segments reference invalid clips. Please regenerate sync.`);
    }

    console.log(`   Segment duration range: ${Math.min(...segments.map(s => s.duration)).toFixed(2)}s - ${Math.max(...segments.map(s => s.duration)).toFixed(2)}s`);
    console.log(`   Total video duration: ${segments.reduce((sum, s) => sum + s.duration, 0).toFixed(2)}s`);

    // MEMORY-SAFE APPROACH: Very small batches, store results in JS memory, reload FFmpeg between batches
    const BATCH_SIZE = 3; // Very small batches to avoid WASM memory limits
    const RELOAD_EVERY_N_BATCHES = 2; // Reload FFmpeg every N batches to clear WASM memory
    const totalBatches = Math.ceil(segments.length / BATCH_SIZE);

    // Store batch results in JavaScript memory (not WASM)
    let accumulatedVideoBlob: Blob | null = null;
    const audioData = await fetchFile(audioFile);

    console.log(`📹 Processing ${segments.length} segments in ${totalBatches} batches (size: ${BATCH_SIZE}, reload every ${RELOAD_EVERY_N_BATCHES})`);

    try {
      for (let batch = 0; batch < totalBatches; batch++) {
        const batchStart = batch * BATCH_SIZE;
        const batchEnd = Math.min(batchStart + BATCH_SIZE, segments.length);
        const batchSegments = segments.slice(batchStart, batchEnd);

        // Reload FFmpeg periodically to clear WASM memory
        if (batch % RELOAD_EVERY_N_BATCHES === 0) {
          console.log(`🔄 Batch ${batch + 1}: Reloading FFmpeg to clear WASM memory...`);
          await this.reload();
        }

        const ffmpeg = this.ffmpeg!;
        console.log(`📦 Batch ${batch + 1}/${totalBatches} (segments ${batchStart + 1}-${batchEnd})`);

        // Load only clips needed for this batch
        const batchClipIndices = [...new Set(batchSegments.map(s => s.videoIndex))];
        for (const clipIdx of batchClipIndices) {
          const clip = videoClips[clipIdx];
          if (!clip) continue;
          try {
            let videoData: Uint8Array;
            if (clip.file) {
              videoData = await fetchFile(clip.file);
            } else if (clip.url) {
              videoData = await fetchFile(clip.url);
            } else {
              continue;
            }
            await ffmpeg.writeFile(`v${clipIdx}.mp4`, videoData);
            console.log(`  ✓ Loaded clip ${clipIdx}: ${clip.name}`);
          } catch (e) {
            console.error(`  ❌ Failed to load clip ${clipIdx}:`, e);
          }
        }

        // If we have accumulated video from previous batches, write it back
        if (accumulatedVideoBlob) {
          const accData = await fetchFile(accumulatedVideoBlob);
          await ffmpeg.writeFile('accumulated.mp4', accData);
        }

        const segmentFiles: string[] = [];

        // Extract each segment in this batch
        for (let i = 0; i < batchSegments.length; i++) {
          const seg = batchSegments[i];
          const globalIdx = batchStart + i;
          const clipIdx = seg.videoIndex;
          const segFile = `seg${i}.mp4`;

          if (!isFinite(seg.clipStartTime) || !isFinite(seg.duration) || seg.duration <= 0) {
            console.warn(`  ⚠️ Skipping invalid segment ${globalIdx}`);
            continue;
          }

          // Use faster encoding settings to reduce memory pressure
          const extractCmd = [
            '-ss', seg.clipStartTime.toFixed(3),
            '-i', `v${clipIdx}.mp4`,
            '-t', seg.duration.toFixed(3),
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-crf', '30', // Higher CRF = smaller files = less memory
            '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30',
            '-an',
            '-y',
            segFile
          ];

          try {
            await ffmpeg.exec(extractCmd);
            segmentFiles.push(segFile);
          } catch (segError) {
            console.error(`  ❌ Segment ${globalIdx} failed:`, segError);
          }

          onProgress((globalIdx + 1) / segments.length * 0.8);
        }

        if (segmentFiles.length === 0) {
          console.warn(`  ⚠️ Batch ${batch + 1} has no valid segments, skipping`);
          continue;
        }

        // Concat this batch's segments
        const batchList = segmentFiles.map(f => `file '${f}'`).join('\n');
        await ffmpeg.writeFile('batch_list.txt', batchList);

        await ffmpeg.exec([
          '-f', 'concat', '-safe', '0', '-i', 'batch_list.txt',
          '-c', 'copy', '-y', 'batch.mp4'
        ]);

        // Merge with accumulated video if exists
        if (accumulatedVideoBlob) {
          const mergeList = `file 'accumulated.mp4'\nfile 'batch.mp4'`;
          await ffmpeg.writeFile('merge_list.txt', mergeList);

          await ffmpeg.exec([
            '-f', 'concat', '-safe', '0', '-i', 'merge_list.txt',
            '-c', 'copy', '-y', 'merged.mp4'
          ]);

          // Read merged result back to JS memory
          const mergedData = await ffmpeg.readFile('merged.mp4');
          accumulatedVideoBlob = new Blob([mergedData], { type: 'video/mp4' });
        } else {
          // First batch - just read batch result
          const batchData = await ffmpeg.readFile('batch.mp4');
          accumulatedVideoBlob = new Blob([batchData], { type: 'video/mp4' });
        }

        console.log(`  ✓ Batch ${batch + 1} complete. Accumulated size: ${(accumulatedVideoBlob.size / 1024 / 1024).toFixed(2)} MB`);
      }

      if (!accumulatedVideoBlob) {
        throw new Error('No video segments were successfully processed.');
      }

      // Final step: Add audio
      console.log(`🔗 Adding audio to final video...`);
      onProgress(0.85);

      // Reload for final merge to ensure clean memory
      await this.reload();
      const ffmpeg = this.ffmpeg!;

      // Write video and audio
      const videoData = await fetchFile(accumulatedVideoBlob);
      await ffmpeg.writeFile('video.mp4', videoData);
      await ffmpeg.writeFile('audio.mp3', audioData);

      // Add audio
      await ffmpeg.exec([
        '-i', 'video.mp4',
        '-i', 'audio.mp3',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-shortest',
        '-movflags', '+faststart',
        '-y',
        'output.mp4'
      ]);

      onProgress(0.95);

      // Read final output
      console.log("📦 Reading output file...");
      const data = await ffmpeg.readFile('output.mp4');

      if (!data || (data as Uint8Array).length < 1000) {
        throw new Error('Output file is empty or too small');
      }

      console.log(`✅ Export complete! File size: ${((data as Uint8Array).length / 1024 / 1024).toFixed(2)} MB`);

      onProgress(1);
      return new Blob([data], { type: 'video/mp4' });

    } catch (err) {
      console.error("FFmpeg export failed:", err);
      throw new Error(`Export failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      // Always terminate to free memory
      if (this.ffmpeg) {
        try { this.ffmpeg.terminate(); } catch {}
        this.ffmpeg = null;
        this.loaded = false;
      }
    }
  }
}

export const renderService = new RenderService();
