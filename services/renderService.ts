import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { SyncSegment, VideoClip } from '../types';

export class RenderService {
  private ffmpeg: FFmpeg | null = null;
  private loaded: boolean = false;

  private log(message: string, ...args: any[]) {
    console.log(`[RenderService] ${message}`, ...args);
  }

  async load(forceReload: boolean = false) {
    this.log('load() called, current state:', { 
      hasInstance: !!this.ffmpeg, 
      loaded: this.loaded,
      forceReload 
    });

    if (this.loaded && !forceReload) return;
    
    // If forcing reload, terminate existing instance
    if (forceReload && this.ffmpeg) {
      this.log('Terminating existing FFmpeg instance...');
      try {
        this.ffmpeg.terminate();
      } catch (e) {
        this.log('Terminate error (ignored):', e);
      }
      this.ffmpeg = null;
      this.loaded = false;
    }

    this.log('Creating new FFmpeg instance...');
    this.ffmpeg = new FFmpeg();
    
    if (!crossOriginIsolated) {
      console.warn("SharedArrayBuffer not available - COOP/COEP headers missing");
    }

    const baseURL = '/ffmpeg';
    
    try {
      this.log('Loading FFmpeg WASM...');
      await this.ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
      });
      this.loaded = true;
      this.log('✅ FFmpeg loaded successfully');
    } catch (e) {
      console.error("Failed to load FFmpeg", e);
      throw new Error("FFmpeg failed to initialize. Server may be missing COOP/COEP headers.");
    }
  }

  /**
   * Restart FFmpeg to clear WASM memory
   */
  private async restartFFmpeg() {
    this.log('🔄 Restarting FFmpeg to reset WASM memory...');
    await this.load(true);
  }

  /**
   * Clean up files from FFmpeg virtual filesystem
   */
  private async cleanup(files: string[]) {
    if (!this.ffmpeg) return;
    for (const file of files) {
      try {
        await this.ffmpeg.deleteFile(file);
      } catch (e) {
        // File may not exist, ignore
      }
    }
  }

  async exportVideo(
    audioFile: File,
    segments: SyncSegment[],
    videoClips: VideoClip[],
    onProgress: (progress: number) => void
  ): Promise<Blob> {
    // Configuration
    const CHUNK_SIZE = 20; // Process 20 segments at a time
    const OUTPUT_WIDTH = 1280;
    const OUTPUT_HEIGHT = 720;

    console.log('═══════════════════════════════════════════════════════');
    console.log('🎬 STARTING CHUNKED EXPORT');
    console.log(`   Segments: ${segments.length}, Clips: ${videoClips.length}`);
    console.log(`   Chunk size: ${CHUNK_SIZE}`);
    console.log('═══════════════════════════════════════════════════════');

    await this.load();
    const ffmpeg = this.ffmpeg!;

    const totalChunks = Math.ceil(segments.length / CHUNK_SIZE);
    const chunkOutputs: string[] = [];

    // STEP 1: Process segments in chunks
    for (let chunkIdx = 0; chunkIdx < totalChunks; chunkIdx++) {
      const chunkStart = chunkIdx * CHUNK_SIZE;
      const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, segments.length);
      const chunkSegments = segments.slice(chunkStart, chunkEnd);

      console.log('───────────────────────────────────────────────────────');
      console.log(`🔄 Processing chunk ${chunkIdx + 1}/${totalChunks}: segments ${chunkStart + 1}-${chunkEnd}`);

      // Find which clips this chunk needs
      const neededClipIndices = new Set(chunkSegments.map(s => s.videoIndex));
      const loadedFiles: string[] = [];

      // Load only needed clips for this chunk
      for (const clipIdx of neededClipIndices) {
        const clip = videoClips[clipIdx];
        if (!clip?.file) {
          console.warn(`   ⚠️ Clip ${clipIdx} missing file, skipping`);
          continue;
        }
        const filename = `clip${clipIdx}.mp4`;
        console.log(`   📂 Loading: ${clip.name} (${(clip.file.size / 1024 / 1024).toFixed(1)}MB)`);
        await ffmpeg.writeFile(filename, await fetchFile(clip.file));
        loadedFiles.push(filename);
      }

      // Build filter for this chunk
      let filterComplex = '';
      const inputMap = new Map<number, number>();
      let inputCounter = 0;

      for (const clipIdx of neededClipIndices) {
        inputMap.set(clipIdx, inputCounter++);
      }

      // Create trim filters for each segment (with validation)
      const validSegments: number[] = [];
      chunkSegments.forEach((seg, idx) => {
        const inputIdx = inputMap.get(seg.videoIndex);
        if (inputIdx === undefined) return;

        // Ensure minimum duration and round values for FFmpeg compatibility
        const duration = Math.max(0.1, Math.round(seg.duration * 1000) / 1000);
        const startTime = Math.max(0, Math.round(seg.clipStartTime * 1000) / 1000);

        filterComplex += `[${inputIdx}:v]trim=start=${startTime}:duration=${duration},setpts=PTS-STARTPTS,scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease,pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2,setsar=1[v${idx}];`;
        validSegments.push(idx);
      });

      // Only concat valid segments
      if (validSegments.length === 0) {
        console.warn(`   ⚠️ Chunk ${chunkIdx + 1} has no valid segments, skipping`);
        continue;
      }
      filterComplex += validSegments.map(i => `[v${i}]`).join('');
      filterComplex += `concat=n=${validSegments.length}:v=1:a=0[outv]`;

      const chunkOutput = `chunk_${chunkIdx}.mp4`;
      
      const cmd = [
        ...Array.from(neededClipIndices).map(i => ['-i', `clip${i}.mp4`]).flat(),
        '-filter_complex', filterComplex,
        '-map', '[outv]',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p',
        '-y',
        chunkOutput
      ];

      console.log(`   🎬 Running FFmpeg for chunk ${chunkIdx + 1}...`);
      try {
        await ffmpeg.exec(cmd);
        chunkOutputs.push(chunkOutput);
      } catch (err) {
        console.error(`   ❌ FFmpeg exec failed for chunk ${chunkIdx + 1}:`, err);
        console.error(`   Filter: ${filterComplex.substring(0, 200)}...`);
        throw new Error(`FFmpeg failed on chunk ${chunkIdx + 1}: ${err}`);
      }

      // Clean up input clips to free memory
      await this.cleanup(loadedFiles);

      // Report progress
      const chunkProgress = (chunkIdx + 1) / (totalChunks + 2); // +2 for merge and audio steps
      onProgress(chunkProgress * 0.7); // 70% for chunk processing

      console.log(`   ✅ Chunk ${chunkIdx + 1} complete`);

      // Restart FFmpeg every few chunks to prevent memory buildup
      if ((chunkIdx + 1) % 3 === 0 && chunkIdx < totalChunks - 1) {
        // Save chunk outputs before restart
        const savedChunks: Map<string, Uint8Array> = new Map();
        for (const output of chunkOutputs) {
          try {
            const data = await ffmpeg.readFile(output);
            savedChunks.set(output, data as Uint8Array);
          } catch (e) {
            console.warn(`   Could not save ${output}:`, e);
          }
        }

        await this.restartFFmpeg();

        // Restore chunk outputs
        for (const [name, data] of savedChunks) {
          await this.ffmpeg!.writeFile(name, data);
        }
      }
    }

    // STEP 2: Merge all chunks
    console.log('───────────────────────────────────────────────────────');
    console.log('🔗 STEP 2: Merging chunks');

    // Create concat list
    let concatList = '';
    for (const chunk of chunkOutputs) {
      concatList += `file '${chunk}'\n`;
    }
    await ffmpeg.writeFile('concat_list.txt', concatList);
    console.log(`   📝 Concat list: ${chunkOutputs.length} files`);

    await ffmpeg.exec([
      '-f', 'concat',
      '-safe', '0',
      '-i', 'concat_list.txt',
      '-c', 'copy',
      '-y',
      'merged.mp4'
    ]);

    // Clean up chunks
    await this.cleanup(chunkOutputs);
    await this.cleanup(['concat_list.txt']);
    
    const mergedData = await ffmpeg.readFile('merged.mp4');
    const mergedSize = (mergedData as Uint8Array).length / 1024 / 1024;
    console.log(`   ✅ Merged video: ${mergedSize.toFixed(2)} MB`);

    onProgress(0.85);

    // STEP 3: Add audio
    console.log('───────────────────────────────────────────────────────');
    console.log('🎵 STEP 3: Adding audio');

    // Restart FFmpeg to clear memory before final step
    await this.restartFFmpeg();

    // Reload merged video and audio
    await this.ffmpeg!.writeFile('merged.mp4', mergedData as Uint8Array);
    console.log(`   📂 Uploading audio: ${audioFile.name} (${(audioFile.size / 1024 / 1024).toFixed(2)} MB)`);
    await this.ffmpeg!.writeFile('audio.mp3', await fetchFile(audioFile));

    console.log('   🔊 Muxing audio and video...');
    await this.ffmpeg!.exec([
      '-i', 'merged.mp4',
      '-i', 'audio.mp3',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      '-y',
      'final.mp4'
    ]);

    // Read final output
    console.log('   📖 Reading final output...');
    const finalData = await this.ffmpeg!.readFile('final.mp4');
    const finalSize = (finalData as Uint8Array).length / 1024 / 1024;

    // Cleanup
    await this.cleanup(['merged.mp4', 'audio.mp3', 'final.mp4']);

    onProgress(1.0);

    console.log('═══════════════════════════════════════════════════════');
    console.log(`✅ EXPORT COMPLETE: ${finalSize.toFixed(2)} MB`);
    console.log('═══════════════════════════════════════════════════════');

    return new Blob([finalData], { type: 'video/mp4' });
  }
}

export const renderService = new RenderService();