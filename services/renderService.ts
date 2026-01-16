import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import { SyncSegment, VideoClip } from '../types';

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
    segments: SyncSegment[],
    videoClips: VideoClip[],
    onProgress: (progress: number) => void
  ): Promise<Blob> {
    if (!this.ffmpeg || !this.loaded) await this.load();
    const ffmpeg = this.ffmpeg!;

    ffmpeg.on('progress', ({ progress }) => {
        onProgress(progress);
    });

    console.log("Starting FFmpeg Render...");

    // 1. Write Audio
    await ffmpeg.writeFile('audio.mp3', await fetchFile(audioFile));

    // 2. Write Video Clips
    // Only write clips that are actually used to save memory
    const usedIndices = new Set(segments.map(s => s.videoIndex));
    for (const i of usedIndices) {
        const clip = videoClips[i];
        console.log(`Loading clip ${i}: ${clip.name}`);
        await ffmpeg.writeFile(`clip${i}.mp4`, await fetchFile(clip.file));
    }

    // 3. Build Filter Complex
    let filterComplex = '';
    let inputs = '';
    
    // -i 0 is audio
    // -i 1 is clip0 (if used), etc.
    // We need to map videoIndex to FFmpeg input index
    const inputMap = new Map<number, number>();
    let inputCounter = 1; // 0 is audio

    for (const i of usedIndices) {
        inputs += `-i clip${i}.mp4 `;
        inputMap.set(i, inputCounter++);
    }

    segments.forEach((seg, idx) => {
        const inputIdx = inputMap.get(seg.videoIndex);
        // Trim segment and reset timestamps
        // Also force scale to 1280x720 to avoid resolution mismatch errors during concatenation
        filterComplex += `[${inputIdx}:v]trim=start=${seg.clipStartTime}:duration=${seg.duration},setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2[v${idx}];`;
    });

    // Concatenate all segments
    filterComplex += segments.map((_, i) => `[v${i}]`).join('');
    filterComplex += `concat=n=${segments.length}:v=1:a=0[outv]`;

    const cmd = [
        '-i', 'audio.mp3',
        ...Array.from(usedIndices).map(i => ['-i', `clip${i}.mp4`]).flat(),
        '-filter_complex', filterComplex,
        '-map', '[outv]',
        '-map', '0:a', // Map audio from input 0
        '-c:v', 'libx264', // H.264
        '-preset', 'ultrafast', // Speed over size
        '-shortest', // Stop when shortest stream ends (usually audio)
        'output.mp4'
    ].flat();

    console.log("FFmpeg Command:", cmd.join(' '));

    await ffmpeg.exec(cmd);

    // 4. Read Output
    const data = await ffmpeg.readFile('output.mp4');

    // 5. Cleanup - Delete all files from virtual FS to free memory
    try {
      await ffmpeg.deleteFile('audio.mp3');
      await ffmpeg.deleteFile('output.mp4');
      for (const i of usedIndices) {
        await ffmpeg.deleteFile(`clip${i}.mp4`);
      }
      console.log("✅ FFmpeg cleanup complete");
    } catch (cleanupErr) {
      console.warn("FFmpeg cleanup warning:", cleanupErr);
    }

    return new Blob([data], { type: 'video/mp4' });
  }
}

export const renderService = new RenderService();