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
    if (!this.ffmpeg || !this.loaded) await this.load();
    const ffmpeg = this.ffmpeg!;

    ffmpeg.on('progress', ({ progress }) => {
        onProgress(Math.max(0, Math.min(1, progress)));
    });

    console.log("🎬 Starting FFmpeg Render...");
    console.log(`   Processing ${segments.length} segments from ${videoClips.length} clips`);

    // Process ALL segments - no limit
    const workingSegments = segments;

    try {
      // 1. Write Audio
      const audioData = await fetchFile(audioFile);
      await ffmpeg.writeFile('audio.mp3', audioData);
      console.log("✓ Audio loaded");

      // 2. Write only the video clips we need
      const usedIndices = [...new Set(workingSegments.map(s => s.videoIndex))];

      for (const i of usedIndices) {
        const clip = videoClips[i];
        if (!clip || !clip.file) {
          console.warn(`Clip ${i} missing, skipping`);
          continue;
        }
        const videoData = await fetchFile(clip.file);
        await ffmpeg.writeFile(`v${i}.mp4`, videoData);
        console.log(`✓ Loaded clip ${i}: ${clip.name}`);
      }

      // 3. Process in batches to manage memory for long songs
      const BATCH_SIZE = 25;
      const totalBatches = Math.ceil(workingSegments.length / BATCH_SIZE);
      let intermediateFiles: string[] = [];

      for (let batch = 0; batch < totalBatches; batch++) {
        const batchStart = batch * BATCH_SIZE;
        const batchEnd = Math.min(batchStart + BATCH_SIZE, workingSegments.length);
        const batchSegments = workingSegments.slice(batchStart, batchEnd);

        console.log(`📦 Processing batch ${batch + 1}/${totalBatches} (segments ${batchStart + 1}-${batchEnd})`);

        const segmentFiles: string[] = [];

        // Extract each segment in this batch
        for (let i = 0; i < batchSegments.length; i++) {
          const seg = batchSegments[i];
          const globalIdx = batchStart + i;
          const clipIdx = seg.videoIndex;
          const segFile = `seg${globalIdx}.mp4`;

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

          await ffmpeg.exec(extractCmd);
          segmentFiles.push(segFile);

          const overallProgress = (globalIdx + 1) / workingSegments.length * 0.7;
          onProgress(overallProgress);
        }

        // Concat this batch into an intermediate file
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

        console.log(`✓ Batch ${batch + 1} complete`);
      }

      // 4. Final concat of all batches with audio
      console.log("🔗 Final merge with audio...");
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

      // 7. Cleanup
      try {
        await ffmpeg.deleteFile('audio.mp3');
        await ffmpeg.deleteFile('output.mp4');
        for (const i of usedIndices) {
          try { await ffmpeg.deleteFile(`v${i}.mp4`); } catch {}
        }
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
