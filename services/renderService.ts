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

    // Limit segments to avoid FFmpeg memory issues (max 50 segments)
    const maxSegments = 50;
    const workingSegments = segments.length > maxSegments
      ? segments.slice(0, maxSegments)
      : segments;

    if (segments.length > maxSegments) {
      console.warn(`⚠️ Limiting to ${maxSegments} segments (had ${segments.length})`);
    }

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

      // 3. Create a simple concat file approach (more reliable than filter_complex)
      // First, extract each segment to a temp file
      const segmentFiles: string[] = [];

      for (let i = 0; i < workingSegments.length; i++) {
        const seg = workingSegments[i];
        const clipIdx = seg.videoIndex;
        const segFile = `seg${i}.mp4`;

        // Simple extract: just trim the segment from source
        // Use -ss before -i for fast seeking, then -t for duration
        const extractCmd = [
          '-ss', seg.clipStartTime.toFixed(3),
          '-i', `v${clipIdx}.mp4`,
          '-t', seg.duration.toFixed(3),
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-crf', '28',
          '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30',
          '-an', // No audio for segments
          '-y',
          segFile
        ];

        console.log(`Extracting segment ${i + 1}/${workingSegments.length}...`);
        await ffmpeg.exec(extractCmd);
        segmentFiles.push(segFile);

        onProgress((i + 1) / (workingSegments.length + 2) * 0.8);
      }

      // 4. Create concat list file
      const concatList = segmentFiles.map(f => `file '${f}'`).join('\n');
      await ffmpeg.writeFile('list.txt', concatList);
      console.log("✓ Created concat list");

      // 5. Concat all segments and add audio
      console.log("🔗 Concatenating segments with audio...");
      const concatCmd = [
        '-f', 'concat',
        '-safe', '0',
        '-i', 'list.txt',
        '-i', 'audio.mp3',
        '-c:v', 'copy', // Copy video (already encoded)
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
        await ffmpeg.deleteFile('list.txt');
        await ffmpeg.deleteFile('output.mp4');
        for (const i of usedIndices) {
          await ffmpeg.deleteFile(`v${i}.mp4`);
        }
        for (const f of segmentFiles) {
          await ffmpeg.deleteFile(f);
        }
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
