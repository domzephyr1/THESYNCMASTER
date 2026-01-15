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
        // We could try to load a single-threaded version if available, but for now we throw to alert the UI.
        // throw new Error("Browser headers missing for FFmpeg."); 
        // Note: We'll proceed, but it will likely fail on `load` or execution if multi-threaded core is fetched.
    }

    const baseURL = '/ffmpeg';
    
    try {
        await this.ffmpeg.load({
            coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
            wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
        });
        this.loaded = true;
    } catch (e) {
        console.error("Failed to load FFmpeg", e);
        throw new Error("FFmpeg failed to initialize. This usually means the server is missing COOP/COEP headers.");
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
    return new Blob([data], { type: 'video/mp4' });
  }
}

export const renderService = new RenderService();