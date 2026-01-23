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

    // MEMORY-SAFE APPROACH: Store individual segments in JS memory, one final concat
    const BATCH_SIZE = 5; // Segments to process before reloading FFmpeg
    const totalBatches = Math.ceil(segments.length / BATCH_SIZE);

    // Store individual segment blobs in JavaScript memory
    const segmentBlobs: Blob[] = [];
    const audioData = await fetchFile(audioFile);

    console.log(`📹 Processing ${segments.length} segments in ${totalBatches} batches (size: ${BATCH_SIZE})`);

    try {
      for (let batch = 0; batch < totalBatches; batch++) {
        const batchStart = batch * BATCH_SIZE;
        const batchEnd = Math.min(batchStart + BATCH_SIZE, segments.length);
        const batchSegments = segments.slice(batchStart, batchEnd);

        // Reload FFmpeg each batch to clear WASM memory
        console.log(`🔄 Batch ${batch + 1}/${totalBatches}: Loading fresh FFmpeg...`);
        await this.reload();
        const ffmpeg = this.ffmpeg!;

        console.log(`📦 Processing segments ${batchStart + 1}-${batchEnd}`);

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

        // Extract each segment and store as individual blob
        for (let i = 0; i < batchSegments.length; i++) {
          const seg = batchSegments[i];
          const globalIdx = batchStart + i;
          const clipIdx = seg.videoIndex;
          const segFile = `seg.mp4`;

          if (!isFinite(seg.clipStartTime) || !isFinite(seg.duration) || seg.duration <= 0) {
            console.warn(`  ⚠️ Skipping invalid segment ${globalIdx}`);
            continue;
          }

          const extractCmd = [
            '-ss', seg.clipStartTime.toFixed(3),
            '-i', `v${clipIdx}.mp4`,
            '-t', seg.duration.toFixed(3),
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-crf', '28',
            '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30',
            '-an',
            '-y',
            segFile
          ];

          try {
            await ffmpeg.exec(extractCmd);
            // Read segment to JS memory immediately
            const segData = await ffmpeg.readFile(segFile);
            segmentBlobs.push(new Blob([segData], { type: 'video/mp4' }));
            await ffmpeg.deleteFile(segFile);
            console.log(`  ✓ Segment ${globalIdx + 1}/${segments.length}`);
          } catch (segError) {
            console.error(`  ❌ Segment ${globalIdx} failed:`, segError);
          }

          onProgress((globalIdx + 1) / segments.length * 0.7);
        }

        console.log(`  ✓ Batch ${batch + 1} complete. Total segments stored: ${segmentBlobs.length}`);
      }

      if (segmentBlobs.length === 0) {
        throw new Error('No video segments were successfully processed.');
      }

      // Final step: Concat all segments and add audio in chunks
      console.log(`🔗 Final merge: ${segmentBlobs.length} segments + audio...`);
      onProgress(0.75);

      // Process final merge in chunks to avoid memory issues
      const MERGE_CHUNK_SIZE = 10;
      let mergedBlob: Blob | null = null;

      for (let chunk = 0; chunk < segmentBlobs.length; chunk += MERGE_CHUNK_SIZE) {
        const chunkEnd = Math.min(chunk + MERGE_CHUNK_SIZE, segmentBlobs.length);
        const chunkBlobs = segmentBlobs.slice(chunk, chunkEnd);

        console.log(`  🔄 Merging segments ${chunk + 1}-${chunkEnd}...`);
        await this.reload();
        const ffmpeg = this.ffmpeg!;

        // Write segments for this chunk
        const segFiles: string[] = [];
        for (let i = 0; i < chunkBlobs.length; i++) {
          const segData = await fetchFile(chunkBlobs[i]);
          const filename = `s${i}.mp4`;
          await ffmpeg.writeFile(filename, segData);
          segFiles.push(filename);
        }

        // If we have previous merged result, include it
        if (mergedBlob) {
          const prevData = await fetchFile(mergedBlob);
          await ffmpeg.writeFile('prev.mp4', prevData);
          segFiles.unshift('prev.mp4');
        }

        // Concat this chunk
        const listContent = segFiles.map(f => `file '${f}'`).join('\n');
        await ffmpeg.writeFile('list.txt', listContent);

        await ffmpeg.exec([
          '-f', 'concat', '-safe', '0', '-i', 'list.txt',
          '-c', 'copy', '-y', 'merged.mp4'
        ]);

        const mergedData = await ffmpeg.readFile('merged.mp4');
        mergedBlob = new Blob([mergedData], { type: 'video/mp4' });

        onProgress(0.75 + (chunkEnd / segmentBlobs.length) * 0.15);
      }

      if (!mergedBlob) {
        throw new Error('Failed to merge segments.');
      }

      // Final: Add audio
      console.log(`🎵 Adding audio track...`);
      onProgress(0.92);

      await this.reload();
      const ffmpeg = this.ffmpeg!;

      const videoData = await fetchFile(mergedBlob);
      await ffmpeg.writeFile('video.mp4', videoData);
      await ffmpeg.writeFile('audio.mp3', audioData);

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

      onProgress(0.98);

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
