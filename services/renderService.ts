import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { EnhancedSyncSegment, VideoClip } from '../types';

export class RenderService {
  private ffmpeg: FFmpeg | null = null;
  private loaded: boolean = false;
  private coreURL: string | null = null;
  private wasmURL: string | null = null;

  async load(): Promise<boolean> {
    console.log('[RenderService] load() called, current state:', {
      hasInstance: !!this.ffmpeg,
      loaded: this.loaded
    });

    if (this.loaded && this.ffmpeg) {
      console.log('[RenderService] Already loaded, skipping');
      return true;
    }

    // Clean up any existing instance
    if (this.ffmpeg) {
      console.log('[RenderService] Terminating existing instance...');
      try {
        this.ffmpeg.terminate();
      } catch (e) {
        console.warn('[RenderService] Terminate warning:', e);
      }
      this.ffmpeg = null;
    }

    this.loaded = false;

    try {
      console.log('[RenderService] Creating new FFmpeg instance...');
      this.ffmpeg = new FFmpeg();

      this.ffmpeg.on('log', ({ message }) => {
        // Only log important messages to reduce noise
        if (message.includes('error') || message.includes('Error') || message.includes('failed')) {
          console.log('[FFmpeg]', message);
        }
      });

      const baseURL = '/ffmpeg';

      // Cache blob URLs
      if (!this.coreURL) {
        console.log('[RenderService] Fetching core.js...');
        this.coreURL = await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript');
      }
      if (!this.wasmURL) {
        console.log('[RenderService] Fetching core.wasm...');
        this.wasmURL = await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm');
      }

      console.log('[RenderService] Loading FFmpeg WASM...');
      await this.ffmpeg.load({
        coreURL: this.coreURL,
        wasmURL: this.wasmURL,
      });

      this.loaded = true;
      console.log('[RenderService] ✅ FFmpeg loaded successfully');
      return true;

    } catch (e) {
      console.error('[RenderService] ❌ FFmpeg load failed:', e);
      this.ffmpeg = null;
      this.loaded = false;
      return false;
    }
  }

  private async ensureLoaded(): Promise<FFmpeg> {
    if (!this.ffmpeg || !this.loaded) {
      const success = await this.load();
      if (!success || !this.ffmpeg) {
        throw new Error('FFmpeg failed to initialize');
      }
    }
    return this.ffmpeg;
  }

  async exportVideo(
    audioFile: File,
    segments: EnhancedSyncSegment[],
    videoClips: VideoClip[],
    onProgress: (progress: number) => void
  ): Promise<Blob> {
    console.log('═══════════════════════════════════════════════════════');
    console.log('🎬 EXPORT STARTING');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`   Audio: ${audioFile.name} (${(audioFile.size / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`   Segments: ${segments.length}`);
    console.log(`   Clips: ${videoClips.length}`);

    // Validate inputs
    if (!segments?.length) throw new Error('No segments to render');
    if (!videoClips?.length) throw new Error('No video clips available');
    if (!audioFile) throw new Error('No audio file available');

    const clipsWithFiles = videoClips.filter(c => c.file || c.url);
    if (clipsWithFiles.length === 0) {
      throw new Error('Video clips are missing file data. Please re-upload videos.');
    }

    const invalidSegments = segments.filter(s => s.videoIndex < 0 || s.videoIndex >= videoClips.length);
    if (invalidSegments.length > 0) {
      throw new Error(`${invalidSegments.length} segments reference invalid clips`);
    }

    console.log(`   Duration range: ${Math.min(...segments.map(s => s.duration)).toFixed(2)}s - ${Math.max(...segments.map(s => s.duration)).toFixed(2)}s`);
    console.log(`   Total duration: ${segments.reduce((sum, s) => sum + s.duration, 0).toFixed(2)}s`);

    // Load FFmpeg ONCE at the start - no reloading during export
    console.log('───────────────────────────────────────────────────────');
    console.log('📦 STEP 1: Loading FFmpeg');
    console.log('───────────────────────────────────────────────────────');

    const ffmpeg = await this.ensureLoaded();

    // Pre-fetch audio
    console.log('📥 Loading audio file...');
    const audioData = await fetchFile(audioFile);
    console.log(`   Audio data: ${(audioData.length / 1024 / 1024).toFixed(2)} MB`);

    const BATCH_SIZE = 8;
    const segmentBlobs: Blob[] = [];
    const loadedClipIds = new Set<number>();

    console.log('───────────────────────────────────────────────────────');
    console.log(`📹 STEP 2: Processing ${segments.length} segments in batches of ${BATCH_SIZE}`);
    console.log('───────────────────────────────────────────────────────');

    for (let batchNum = 0; batchNum * BATCH_SIZE < segments.length; batchNum++) {
      const batchStart = batchNum * BATCH_SIZE;
      const batchEnd = Math.min(batchStart + BATCH_SIZE, segments.length);
      const batchSegments = segments.slice(batchStart, batchEnd);

      console.log(`\n📦 BATCH ${batchNum + 1}: Segments ${batchStart + 1}-${batchEnd}`);

      // Find clips needed for this batch
      const neededClipIds = [...new Set(batchSegments.map(s => s.videoIndex))];

      // Unload clips we don't need anymore (free memory)
      for (const loadedId of loadedClipIds) {
        if (!neededClipIds.includes(loadedId)) {
          try {
            await ffmpeg.deleteFile(`v${loadedId}.mp4`);
            loadedClipIds.delete(loadedId);
            console.log(`   🗑️ Unloaded clip ${loadedId + 1}`);
          } catch {}
        }
      }

      // Load clips we need
      for (const clipId of neededClipIds) {
        if (loadedClipIds.has(clipId)) continue;

        const clip = videoClips[clipId];
        if (!clip) {
          console.warn(`   ⚠️ Clip ${clipId + 1} not found`);
          continue;
        }

        console.log(`   📥 Loading clip ${clipId + 1}: ${clip.name}...`);
        try {
          const videoData = clip.file
            ? await fetchFile(clip.file)
            : clip.url
              ? await fetchFile(clip.url)
              : null;

          if (!videoData) {
            console.warn(`   ⚠️ Clip ${clipId + 1} has no data`);
            continue;
          }

          await ffmpeg.writeFile(`v${clipId}.mp4`, videoData);
          loadedClipIds.add(clipId);
          console.log(`   ✅ Clip ${clipId + 1} loaded (${(videoData.length / 1024 / 1024).toFixed(2)} MB)`);
        } catch (e) {
          console.error(`   ❌ Failed to load clip ${clipId + 1}:`, e);
        }
      }

      // Process each segment in this batch
      for (let i = 0; i < batchSegments.length; i++) {
        const seg = batchSegments[i];
        const globalIdx = batchStart + i;
        const clipId = seg.videoIndex;

        if (!isFinite(seg.clipStartTime) || !isFinite(seg.duration) || seg.duration <= 0) {
          console.warn(`   ⚠️ Segment ${globalIdx + 1}: Invalid data, skipping`);
          continue;
        }

        if (!loadedClipIds.has(clipId)) {
          console.warn(`   ⚠️ Segment ${globalIdx + 1}: Clip ${clipId + 1} not loaded, skipping`);
          continue;
        }

        const segFile = `seg_${globalIdx}.mp4`;

        console.log(`   🎞️ Segment ${globalIdx + 1}/${segments.length}: clip=${clipId + 1}, start=${seg.clipStartTime.toFixed(2)}s, dur=${seg.duration.toFixed(2)}s`);

        try {
          await ffmpeg.exec([
            '-ss', seg.clipStartTime.toFixed(3),
            '-i', `v${clipId}.mp4`,
            '-t', seg.duration.toFixed(3),
            '-c:v', 'libx264',
            '-preset', 'ultrafast',
            '-crf', '28',
            '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,fps=30',
            '-an',
            '-y',
            segFile
          ]);

          const segData = await ffmpeg.readFile(segFile);
          segmentBlobs.push(new Blob([segData], { type: 'video/mp4' }));

          try { await ffmpeg.deleteFile(segFile); } catch {}

          console.log(`   ✅ Segment ${globalIdx + 1} done (${(segData.length / 1024).toFixed(0)} KB)`);
        } catch (e) {
          console.error(`   ❌ Segment ${globalIdx + 1} FAILED:`, e);
          // Continue with other segments
        }

        onProgress((globalIdx + 1) / segments.length * 0.7);
      }

      console.log(`   📊 Batch ${batchNum + 1} complete. Blobs collected: ${segmentBlobs.length}`);
    }

    // Clean up all clips
    console.log('\n🧹 Cleaning up loaded clips...');
    for (const clipId of loadedClipIds) {
      try { await ffmpeg.deleteFile(`v${clipId}.mp4`); } catch {}
    }
    loadedClipIds.clear();

    if (segmentBlobs.length === 0) {
      throw new Error('No segments were successfully processed');
    }

    console.log('───────────────────────────────────────────────────────');
    console.log(`🔗 STEP 3: Merging ${segmentBlobs.length} segments`);
    console.log('───────────────────────────────────────────────────────');
    onProgress(0.75);

    // Merge all segments
    const MERGE_CHUNK = 20;
    let mergedBlob: Blob | null = null;

    for (let i = 0; i < segmentBlobs.length; i += MERGE_CHUNK) {
      const chunkEnd = Math.min(i + MERGE_CHUNK, segmentBlobs.length);
      const chunkBlobs = segmentBlobs.slice(i, chunkEnd);

      console.log(`   🔄 Merging chunk: segments ${i + 1}-${chunkEnd}`);

      // Write chunk files
      const files: string[] = [];

      if (mergedBlob) {
        const prevData = await fetchFile(mergedBlob);
        await ffmpeg.writeFile('prev.mp4', prevData);
        files.push('prev.mp4');
      }

      for (let j = 0; j < chunkBlobs.length; j++) {
        const data = await fetchFile(chunkBlobs[j]);
        const fname = `m${j}.mp4`;
        await ffmpeg.writeFile(fname, data);
        files.push(fname);
      }

      // Create concat list
      const listContent = files.map(f => `file '${f}'`).join('\n');
      await ffmpeg.writeFile('list.txt', listContent);

      console.log(`   📝 Concat list: ${files.length} files`);

      await ffmpeg.exec([
        '-f', 'concat', '-safe', '0', '-i', 'list.txt',
        '-c', 'copy', '-y', 'merged.mp4'
      ]);

      const mergedData = await ffmpeg.readFile('merged.mp4');
      mergedBlob = new Blob([mergedData], { type: 'video/mp4' });

      console.log(`   ✅ Merged chunk done (${(mergedBlob.size / 1024 / 1024).toFixed(2)} MB)`);

      // Cleanup
      for (const f of files) {
        try { await ffmpeg.deleteFile(f); } catch {}
      }
      try { await ffmpeg.deleteFile('list.txt'); } catch {}
      try { await ffmpeg.deleteFile('merged.mp4'); } catch {}

      onProgress(0.75 + ((chunkEnd / segmentBlobs.length) * 0.15));
    }

    if (!mergedBlob) {
      throw new Error('Failed to merge segments');
    }

    console.log('───────────────────────────────────────────────────────');
    console.log('🎵 STEP 4: Adding audio');
    console.log('───────────────────────────────────────────────────────');
    onProgress(0.92);

    const videoData = await fetchFile(mergedBlob);
    await ffmpeg.writeFile('video.mp4', videoData);
    await ffmpeg.writeFile('audio.mp3', audioData);

    console.log('   🔊 Muxing audio and video...');

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

    console.log('   📖 Reading final output...');
    const outputData = await ffmpeg.readFile('output.mp4');

    if (!outputData || (outputData as Uint8Array).length < 1000) {
      throw new Error('Output file is empty or too small');
    }

    const outputBlob = new Blob([outputData], { type: 'video/mp4' });

    // Cleanup
    try { await ffmpeg.deleteFile('video.mp4'); } catch {}
    try { await ffmpeg.deleteFile('audio.mp3'); } catch {}
    try { await ffmpeg.deleteFile('output.mp4'); } catch {}

    console.log('═══════════════════════════════════════════════════════');
    console.log(`✅ EXPORT COMPLETE: ${(outputBlob.size / 1024 / 1024).toFixed(2)} MB`);
    console.log('═══════════════════════════════════════════════════════');

    onProgress(1);
    return outputBlob;
  }

  terminate() {
    if (this.ffmpeg) {
      try {
        this.ffmpeg.terminate();
      } catch {}
      this.ffmpeg = null;
      this.loaded = false;
    }
  }
}

export const renderService = new RenderService();
