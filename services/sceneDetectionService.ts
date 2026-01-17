// Scene Detection Service
// Detects visual scene changes in video clips using frame comparison

export interface SceneMarker {
  time: number;
  confidence: number; // 0-1, how significant the scene change is
}

export interface SceneDetectionResult {
  scenes: SceneMarker[];
  totalScenes: number;
  averageSceneDuration: number;
}

class SceneDetectionService {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;

  // Sampling parameters
  private readonly SAMPLE_INTERVAL = 0.5; // Sample every 0.5 seconds
  private readonly FRAME_WIDTH = 160; // Downscaled for performance
  private readonly FRAME_HEIGHT = 90;
  private readonly SCENE_THRESHOLD = 0.25; // 25% pixel difference = scene change
  private readonly MIN_SCENE_DURATION = 1.0; // Minimum 1 second between scenes

  constructor() {
    // Create offscreen canvas for frame analysis
    if (typeof document !== 'undefined') {
      this.canvas = document.createElement('canvas');
      this.canvas.width = this.FRAME_WIDTH;
      this.canvas.height = this.FRAME_HEIGHT;
      this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    }
  }

  // Extract frame data at a specific time
  private async getFrameData(video: HTMLVideoElement, time: number): Promise<Uint8ClampedArray | null> {
    if (!this.canvas || !this.ctx) return null;

    return new Promise((resolve) => {
      const onSeeked = () => {
        video.removeEventListener('seeked', onSeeked);

        // Draw frame to canvas
        this.ctx!.drawImage(video, 0, 0, this.FRAME_WIDTH, this.FRAME_HEIGHT);

        // Get pixel data
        const imageData = this.ctx!.getImageData(0, 0, this.FRAME_WIDTH, this.FRAME_HEIGHT);
        resolve(imageData.data);
      };

      video.addEventListener('seeked', onSeeked);
      video.currentTime = time;
    });
  }

  // Calculate difference between two frames (0-1)
  private calculateFrameDifference(frame1: Uint8ClampedArray, frame2: Uint8ClampedArray): number {
    if (frame1.length !== frame2.length) return 0;

    let totalDiff = 0;
    const pixelCount = frame1.length / 4; // RGBA = 4 values per pixel

    for (let i = 0; i < frame1.length; i += 4) {
      // Compare RGB values (ignore alpha)
      const rDiff = Math.abs(frame1[i] - frame2[i]) / 255;
      const gDiff = Math.abs(frame1[i + 1] - frame2[i + 1]) / 255;
      const bDiff = Math.abs(frame1[i + 2] - frame2[i + 2]) / 255;

      // Average color difference for this pixel
      totalDiff += (rDiff + gDiff + bDiff) / 3;
    }

    return totalDiff / pixelCount;
  }

  // Detect scenes in a video
  async detectScenes(
    videoUrl: string,
    onProgress?: (progress: number) => void
  ): Promise<SceneDetectionResult> {
    const video = document.createElement('video');
    video.src = videoUrl;
    video.muted = true;
    video.preload = 'auto';

    // Wait for video metadata
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('Failed to load video'));
    });

    const duration = video.duration;
    const scenes: SceneMarker[] = [];
    let previousFrame: Uint8ClampedArray | null = null;
    let lastSceneTime = 0;

    // Always mark the start as a scene
    scenes.push({ time: 0, confidence: 1.0 });

    // Sample frames throughout the video
    const sampleCount = Math.floor(duration / this.SAMPLE_INTERVAL);

    for (let i = 1; i < sampleCount; i++) {
      const time = i * this.SAMPLE_INTERVAL;

      // Report progress
      if (onProgress) {
        onProgress(i / sampleCount);
      }

      // Get current frame
      const currentFrame = await this.getFrameData(video, time);
      if (!currentFrame) continue;

      // Compare with previous frame
      if (previousFrame) {
        const difference = this.calculateFrameDifference(previousFrame, currentFrame);

        // Check if this is a scene change
        if (difference > this.SCENE_THRESHOLD && (time - lastSceneTime) >= this.MIN_SCENE_DURATION) {
          // Scale confidence based on how much above threshold
          const confidence = Math.min(1.0, difference / 0.5);
          scenes.push({ time, confidence });
          lastSceneTime = time;
        }
      }

      previousFrame = currentFrame;
    }

    // Clean up
    video.src = '';

    // Calculate statistics
    const totalScenes = scenes.length;
    const averageSceneDuration = totalScenes > 1
      ? duration / totalScenes
      : duration;

    console.log(`🎬 Scene Detection: Found ${totalScenes} scenes in ${duration.toFixed(1)}s video`);

    return {
      scenes,
      totalScenes,
      averageSceneDuration
    };
  }

  // Quick check if a clip should be auto-split (>30s with multiple scenes)
  async shouldAutoSplit(videoUrl: string): Promise<{ shouldSplit: boolean; sceneCount: number }> {
    const video = document.createElement('video');
    video.src = videoUrl;
    video.muted = true;
    video.preload = 'metadata';

    await new Promise<void>((resolve) => {
      video.onloadedmetadata = () => resolve();
    });

    const duration = video.duration;
    video.src = '';

    // Only suggest split for clips longer than 30 seconds
    if (duration < 30) {
      return { shouldSplit: false, sceneCount: 1 };
    }

    // Quick scene detection for long clips
    const result = await this.detectScenes(videoUrl);

    return {
      shouldSplit: result.totalScenes > 3,
      sceneCount: result.totalScenes
    };
  }

  // Generate sub-clips based on detected scenes
  generateSubClipRanges(scenes: SceneMarker[], duration: number): { start: number; end: number }[] {
    const ranges: { start: number; end: number }[] = [];

    for (let i = 0; i < scenes.length; i++) {
      const start = scenes[i].time;
      const end = i < scenes.length - 1 ? scenes[i + 1].time : duration;
      ranges.push({ start, end });
    }

    return ranges;
  }
}

export const sceneDetectionService = new SceneDetectionService();
