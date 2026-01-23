import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { EnhancedSyncSegment, VideoClip } from '../types';

export class RenderService {
  private ffmpeg: FFmpeg | null = null;
  private loaded: boolean = false;

  async load() {
    if (this.loaded) return;

    this.ffmpeg = new FFmpeg();

    // Log FFmpeg output for debugging
    this.ffmpeg.on('log', ({ message }) => {
      console.log('[FFmpeg]', message);
    });

    const baseURL = '/ffmpeg';

    try {
        await this.ffmpeg.load({
            coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
            wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
        });
        this.loaded = true;
        console.log("✅ FFmpeg loaded successfully");
    } catch (e) {
        console.error("Failed to load FFmpeg", e);
        throw new Error("FFmpeg failed to initialize. Try using 'Quick Record' option instead.");
    }
  }

  async exportVideo(
    audioFile: File,
    segments: EnhancedSyncSegment[],
    videoClips: VideoClip[],
    onProgress: (progress: number) => void
  ): Promise<Blob> {
    console.log("🎬 Starting FFmpeg Render...");
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

    // Log segment summary for debugging
    console.log(`   Segment duration range: ${Math.min(...segments.map(s => s.duration)).toFixed(2)}s - ${Math.max(...segments.map(s => s.duration)).toFixed(2)}s`);
    console.log(`   Total video duration: ${segments.reduce((sum, s) => sum + s.duration, 0).toFixed(2)}s`);

    try {
      if (!this.ffmpeg || !this.loaded) {
        console.log("📦 Loading FFmpeg...");
        await this.load();
      }
    } catch (loadError) {
      console.error("FFmpeg load failed:", loadError);
      throw new Error(`FFmpeg failed to load: ${loadError instanceof Error ? loadError.message : 'Unknown error'}`);
    }

    const ffmpeg = this.ffmpeg!;

    ffmpeg.on('progress', ({ progress }) => {
        onProgress(Math.max(0, Math.min(1, progress)));
    });

    // Process ALL segments - no limit
    const workingSegments = segments;

    try {
      // 1. Write Audio
      const audioData = await fetchFile(audioFile);
      await ffmpeg.writeFile('audio.mp3', audioData);
      console.log("✓ Audio loaded");

      // 2. Process segments in SMALL batches to avoid memory issues
      // Load only clips needed for each batch, then unload them
      const BATCH_SIZE = 10; // Smaller batches for memory efficiency
      const totalBatches = Math.ceil(workingSegments.length / BATCH_SIZE);
      let intermediateFiles: string[] = [];
      const loadedClips = new Set<number>();

      console.log(`📹 Processing ${workingSegments.length} segments in ${totalBatches} batches (${BATCH_SIZE} per batch)`);

      for (let batch = 0; batch < totalBatches; batch++) {
        const batchStart = batch * BATCH_SIZE;
        const batchEnd = Math.min(batchStart + BATCH_SIZE, workingSegments.length);
        const batchSegments = workingSegments.slice(batchStart, batchEnd);

        console.log(`📦 Batch ${batch + 1}/${totalBatches} (segments ${batchStart + 1}-${batchEnd})`);

        // Find which clips this batch needs
        const batchClipIndices = [...new Set(batchSegments.map(s => s.videoIndex))];

        // Unload clips from previous batch that we don't need anymore
        for (const loadedIdx of loadedClips) {
          if (!batchClipIndices.includes(loadedIdx)) {
            try {
              await ffmpeg.deleteFile(`v${loadedIdx}.mp4`);
              loadedClips.delete(loadedIdx);
              console.log(`  🗑️ Unloaded clip ${loadedIdx}`);
            } catch {}
          }
        }

        // Load clips needed for this batch (if not already loaded)
        for (const clipIdx of batchClipIndices) {
          if (loadedClips.has(clipIdx)) continue;

          const clip = videoClips[clipIdx];
          if (!clip) {
            console.warn(`  ⚠️ Clip ${clipIdx} not found, skipping`);
            continue;
          }

          try {
            let videoData: Uint8Array;
            if (clip.file) {
              videoData = await fetchFile(clip.file);
            } else if (clip.url) {
              videoData = await fetchFile(clip.url);
            } else {
              console.warn(`  ⚠️ Clip ${clipIdx} has no file/URL`);
              continue;
            }
            await ffmpeg.writeFile(`v${clipIdx}.mp4`, videoData);
            loadedClips.add(clipIdx);
            console.log(`  ✓ Loaded clip ${clipIdx}: ${clip.name}`);
          } catch (e) {
            console.error(`  ❌ Failed to load clip ${clipIdx}:`, e);
          }
        }

        const segmentFiles: string[] = [];

        // Extract each segment in this batch
        for (let i = 0; i < batchSegments.length; i++) {
          const seg = batchSegments[i];
          const globalIdx = batchStart + i;
          const clipIdx = seg.videoIndex;
          const segFile = `seg${globalIdx}.mp4`;

          // Skip if clip wasn't loaded
          if (!loadedClips.has(clipIdx)) {
            console.warn(`  ⚠️ Skipping segment ${globalIdx} - clip ${clipIdx} not loaded`);
            continue;
          }

          // Validate segment data
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
            segmentFiles.push(segFile);
          } catch (segError) {
            console.error(`  ❌ Segment ${globalIdx} failed:`, segError);
          }

          const overallProgress = (globalIdx + 1) / workingSegments.length * 0.7;
          onProgress(overallProgress);
        }

        // Concat this batch into an intermediate file
        if (segmentFiles.length === 0) {
          console.warn(`  ⚠️ Batch ${batch + 1} has no valid segments, skipping`);
          continue;
        }

        const batchFile = `batch${batch}.mp4`;
        const batchList = segmentFiles.map(f => `file '${f}'`).join('\n');
        await ffmpeg.writeFile(`list${batch}.txt`, batchList);

        await ffmpeg.exec([
          '-f', 'concat',
          '-safe', '0',
          '-i', `list${batch}.txt`,
          '-c', 'copy',
          '-y',
          batchFile
        ]);

        intermediateFiles.push(batchFile);

        // Clean up segment files to free memory
        for (const f of segmentFiles) {
          try { await ffmpeg.deleteFile(f); } catch {}
        }
        try { await ffmpeg.deleteFile(`list${batch}.txt`); } catch {}

        console.log(`  ✓ Batch ${batch + 1} complete`);
      }

      // Unload all remaining clips
      for (const loadedIdx of loadedClips) {
        try { await ffmpeg.deleteFile(`v${loadedIdx}.mp4`); } catch {}
      }
      loadedClips.clear();

      // 4. Final concat of all batches with audio
      if (intermediateFiles.length === 0) {
        throw new Error('No video segments were successfully processed. Check that your video files are valid MP4s.');
      }

      console.log(`🔗 Final merge: ${intermediateFiles.length} batch files with audio...`);
      onProgress(0.75);

      // If multiple batches, concat them first
      let videoFile = intermediateFiles[0];
      if (intermediateFiles.length > 1) {
        const finalList = intermediateFiles.map(f => `file '${f}'`).join('\n');
        await ffmpeg.writeFile('final_list.txt', finalList);

        await ffmpeg.exec([
          '-f', 'concat',
          '-safe', '0',
          '-i', 'final_list.txt',
          '-c', 'copy',
          '-y',
          'video_only.mp4'
        ]);
        videoFile = 'video_only.mp4';
        try { await ffmpeg.deleteFile('final_list.txt'); } catch {}
      }

      onProgress(0.85);

      // 5. Add audio to final video
      const concatCmd = [
        '-i', videoFile,
        '-i', 'audio.mp3',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-shortest',
        '-movflags', '+faststart',
        '-y',
        'output.mp4'
      ];

      await ffmpeg.exec(concatCmd);
      onProgress(0.95);

      // 6. Read output
      console.log("📦 Reading output file...");
      const data = await ffmpeg.readFile('output.mp4');

      if (!data || (data as Uint8Array).length < 1000) {
        throw new Error('Output file is empty or too small');
      }

      console.log(`✅ Export complete! File size: ${((data as Uint8Array).length / 1024 / 1024).toFixed(2)} MB`);

      // 7. Cleanup (clips already unloaded during batch processing)
      try {
        await ffmpeg.deleteFile('audio.mp3');
        await ffmpeg.deleteFile('output.mp4');
        for (const f of intermediateFiles) {
          try { await ffmpeg.deleteFile(f); } catch {}
        }
        try { await ffmpeg.deleteFile('video_only.mp4'); } catch {}
      } catch (e) {
        console.warn("Cleanup warning:", e);
      }

      onProgress(1);
      return new Blob([data], { type: 'video/mp4' });

    } catch (err) {
      console.error("FFmpeg export failed:", err);
      throw new Error(`Export failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }
}

export const renderService = new RenderService();
