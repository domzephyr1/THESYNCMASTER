import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { EnhancedSyncSegment, VideoClip } from '../types';

export class RenderService {
  private ffmpeg: FFmpeg | null = null;
  private loaded: boolean = false;

  async load() {
    if (this.loaded) return;
    
    this.ffmpeg = new FFmpeg();
    
    // Check for SharedArrayBuffer support (Required for FFmpeg.wasm multi-threaded)
    if (!crossOriginIsolated) {
        console.warn("SharedArrayBuffer is not available. Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers are missing.");
        console.warn("This will cause FFmpeg to fall back to single-threaded mode, which may be slower.");
        // Continue anyway - FFmpeg.wasm will attempt single-threaded mode
    }

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
        const errorMessage = crossOriginIsolated
            ? "FFmpeg failed to initialize. Check if FFmpeg files are available at /ffmpeg/"
            : "FFmpeg failed to initialize. Missing COOP/COEP headers. Try using 'Quick Record' option instead.";
        throw new Error(errorMessage);
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
        onProgress(progress);
    });

    console.log("Starting FFmpeg Render...");
    console.log(`Processing ${segments.length} segments from ${videoClips.length} clips`);

    // 1. Write Audio - detect format from file extension
    const audioExt = audioFile.name.split('.').pop()?.toLowerCase() || 'mp3';
    const audioFilename = `audio.${audioExt}`;
    await ffmpeg.writeFile(audioFilename, await fetchFile(audioFile));

    // 2. Write Video Clips
    // Only write clips that are actually used to save memory
    const usedIndices = new Set(segments.map(s => s.videoIndex));
    for (const i of usedIndices) {
        const clip = videoClips[i];
        // Detect video format from file extension
        const videoExt = clip.name.split('.').pop()?.toLowerCase() || 'mp4';
        console.log(`Loading clip ${i}: ${clip.name} (${videoExt})`);
        await ffmpeg.writeFile(`clip${i}.${videoExt}`, await fetchFile(clip.file));
    }

    // 3. Build Filter Complex with speed ramping support
    let filterComplex = '';

    // Map videoIndex to FFmpeg input index and track file extensions
    const inputMap = new Map<number, { inputIdx: number; ext: string }>();
    let inputCounter = 1; // 0 is audio

    for (const i of usedIndices) {
        const clip = videoClips[i];
        const videoExt = clip.name.split('.').pop()?.toLowerCase() || 'mp4';
        inputMap.set(i, { inputIdx: inputCounter++, ext: videoExt });
    }

    segments.forEach((seg, idx) => {
        const inputInfo = inputMap.get(seg.videoIndex)!;
        const inputIdx = inputInfo.inputIdx;

        // Calculate effective duration accounting for playback speed
        // If speed is 1.5x, we need to trim 1.5x more source video to fill the segment duration
        const playbackSpeed = seg.playbackSpeed || 1.0;
        const sourceDuration = seg.duration * playbackSpeed;

        // Build filter chain for this segment:
        // 1. trim - extract source portion
        // 2. setpts - apply speed change (PTS/speed makes video faster)
        // 3. scale/pad - normalize resolution

        if (playbackSpeed !== 1.0) {
            // With speed ramping: trim more source, then speed up/slow down
            filterComplex += `[${inputIdx}:v]trim=start=${seg.clipStartTime}:duration=${sourceDuration},setpts=${(1/playbackSpeed).toFixed(4)}*(PTS-STARTPTS),scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2[v${idx}];`;
        } else {
            // Normal speed
            filterComplex += `[${inputIdx}:v]trim=start=${seg.clipStartTime}:duration=${seg.duration},setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2[v${idx}];`;
        }
    });

    // Concatenate all segments
    filterComplex += segments.map((_, i) => `[v${i}]`).join('');
    filterComplex += `concat=n=${segments.length}:v=1:a=0[outv]`;

    // Build input file list
    const inputFiles: string[] = [];
    for (const i of usedIndices) {
        const info = inputMap.get(i)!;
        inputFiles.push('-i', `clip${i}.${info.ext}`);
    }

    const cmd = [
        '-i', audioFilename,
        ...inputFiles,
        '-filter_complex', filterComplex,
        '-map', '[outv]',
        '-map', '0:a', // Map audio from input 0
        '-c:v', 'libx264', // H.264
        '-preset', 'ultrafast', // Speed over size
        '-crf', '23', // Good quality
        '-c:a', 'aac', // AAC audio for compatibility
        '-b:a', '192k',
        '-shortest', // Stop when shortest stream ends (usually audio)
        '-movflags', '+faststart', // Enable fast start for web playback
        'output.mp4'
    ];

    console.log("FFmpeg Command:", cmd.join(' '));

    await ffmpeg.exec(cmd);

    // 4. Read Output
    const data = await ffmpeg.readFile('output.mp4');

    // 5. Cleanup - Delete all files from virtual FS to free memory
    try {
      await ffmpeg.deleteFile(audioFilename);
      await ffmpeg.deleteFile('output.mp4');
      for (const i of usedIndices) {
        const info = inputMap.get(i)!;
        await ffmpeg.deleteFile(`clip${i}.${info.ext}`);
      }
      console.log("✅ FFmpeg cleanup complete");
    } catch (cleanupErr) {
      console.warn("FFmpeg cleanup warning:", cleanupErr);
    }

    return new Blob([data], { type: 'video/mp4' });
  }
}

export const renderService = new RenderService();