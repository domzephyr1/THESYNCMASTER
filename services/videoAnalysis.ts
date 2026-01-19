import { ClipMetadata } from '../types';

const workerCode = `
self.onmessage = function(e) {
  const { data, width, height, prevData } = e.data;
  let sum = 0;
  let motionSum = 0;
  let horizontalMotion = 0;
  let verticalMotion = 0;

  // Calculate Average Brightness
  for (let i = 0; i < data.length; i += 4) {
    const luminance = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
    sum += luminance;
  }
  const avgBrightness = sum / (data.length / 4);

  // Calculate Variance (Contrast proxy)
  let sumDiffSq = 0;
  for (let i = 0; i < data.length; i += 4) {
    const luminance = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
    const diff = luminance - avgBrightness;
    sumDiffSq += diff * diff;
  }
  const variance = sumDiffSq / (data.length / 4);

  // Calculate Motion (if previous frame provided)
  if (prevData) {
    const gridSize = 16;
    const cellWidth = width / gridSize;
    const cellHeight = height / gridSize;

    for (let gy = 0; gy < gridSize; gy++) {
      for (let gx = 0; gx < gridSize; gx++) {
        let cellDiff = 0;
        const startX = Math.floor(gx * cellWidth);
        const startY = Math.floor(gy * cellHeight);

        for (let y = startY; y < startY + cellHeight && y < height; y++) {
          for (let x = startX; x < startX + cellWidth && x < width; x++) {
            const idx = (y * width + x) * 4;
            const lum1 = (0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]);
            const lum2 = (0.299 * prevData[idx] + 0.587 * prevData[idx + 1] + 0.114 * prevData[idx + 2]);
            cellDiff += Math.abs(lum1 - lum2);
          }
        }

        const normalizedDiff = cellDiff / (cellWidth * cellHeight * 255);
        motionSum += normalizedDiff;

        if (gx < gridSize / 2) horizontalMotion -= normalizedDiff;
        else horizontalMotion += normalizedDiff;

        if (gy < gridSize / 2) verticalMotion -= normalizedDiff;
        else verticalMotion += normalizedDiff;
      }
    }
  }

  // Normalize motion by number of grid cells (16x16 = 256)
  const gridCells = 16 * 16;
  self.postMessage({
    brightness: avgBrightness,
    variance,
    motion: motionSum / gridCells,
    horizontalBias: horizontalMotion / gridCells,
    verticalBias: verticalMotion / gridCells
  });
};
`;

export class VideoAnalysisService {
  private worker: Worker | null = null;
  private workerBlobUrl: string | null = null;

  constructor() {
    try {
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      this.workerBlobUrl = URL.createObjectURL(blob);
      this.worker = new Worker(this.workerBlobUrl);
    } catch (e) {
      console.warn("Worker creation failed, falling back to main thread", e);
    }
  }

  // Cleanup method to terminate worker and revoke blob URL
  destroy() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    if (this.workerBlobUrl) {
      URL.revokeObjectURL(this.workerBlobUrl);
      this.workerBlobUrl = null;
    }
  }

  async analyzeClip(videoUrl: string): Promise<ClipMetadata> {
    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.src = videoUrl;
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = "anonymous";

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });

      // Cleanup function to free video element memory
      const cleanup = () => {
        video.onloadedmetadata = null;
        video.onerror = null;
        video.src = '';
        video.load();
      };

      if (!ctx) {
        cleanup();
        resolve({ brightness: 0.5, contrast: 0.5, motionEnergy: 0.5, processed: true });
        return;
      }

      video.onloadedmetadata = async () => {
        canvas.width = 160;
        canvas.height = 90;

        try {
          // Sample at multiple positions through the video for brightness/contrast
          const positions = [0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9];

          let totalBrightness = 0;
          let totalVariance = 0;
          let totalMotion = 0;
          let maxMotion = 0;
          let maxMotionTime = 0;
          let horizontalBias = 0;
          let verticalBias = 0;
          let motionSamples = 0;

          // For each position, sample brightness AND motion (with closely-spaced frames)
          for (const pos of positions) {
            const baseTime = pos * video.duration;

            // Sample brightness at this position
            video.currentTime = baseTime;
            await new Promise<void>(r => {
              const onSeek = () => {
                video.removeEventListener('seeked', onSeek);
                r();
              };
              video.addEventListener('seeked', onSeek);
            });

            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const frame1Data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

            const result1 = await this.analyzeFrame(ctx, canvas.width, canvas.height, null);
            totalBrightness += result1.brightness;
            totalVariance += result1.variance;

            // Now sample motion by getting a frame ~0.1 seconds later
            const motionOffset = 0.1; // 100ms between frames for motion detection
            const nextTime = Math.min(baseTime + motionOffset, video.duration - 0.01);

            if (nextTime > baseTime) {
              video.currentTime = nextTime;
              await new Promise<void>(r => {
                const onSeek = () => {
                  video.removeEventListener('seeked', onSeek);
                  r();
                };
                video.addEventListener('seeked', onSeek);
              });

              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

              // Analyze motion between the two frames
              const result2 = await this.analyzeFrame(
                ctx,
                canvas.width,
                canvas.height,
                new Uint8ClampedArray(frame1Data)
              );

              totalMotion += result2.motion;
              horizontalBias += result2.horizontalBias;
              verticalBias += result2.verticalBias;
              motionSamples++;

              if (result2.motion > maxMotion) {
                maxMotion = result2.motion;
                maxMotionTime = baseTime;
              }
            }
          }

          const frameCount = positions.length;
          const motionFrameCount = Math.max(1, motionSamples);

          let dominantMotionDirection: 'static' | 'horizontal' | 'vertical' | 'chaotic' = 'static';
          const avgMotion = totalMotion / motionFrameCount;

          if (avgMotion > 0.1) {
            const hBias = Math.abs(horizontalBias / motionFrameCount);
            const vBias = Math.abs(verticalBias / motionFrameCount);

            if (hBias > vBias * 1.5) dominantMotionDirection = 'horizontal';
            else if (vBias > hBias * 1.5) dominantMotionDirection = 'vertical';
            else if (avgMotion > 0.3) dominantMotionDirection = 'chaotic';
          }

          // Scale motion to 0-1 range (typical values are 0.01-0.3 after normalization)
          // Using a multiplier of 5 gives good spread across the range
          const scaledMotion = Math.min(1, avgMotion * 5);

          console.log(`  Motion debug: raw=${avgMotion.toFixed(4)}, scaled=${scaledMotion.toFixed(2)}`);

          cleanup();
          resolve({
            brightness: totalBrightness / frameCount,
            contrast: Math.min(1, (totalVariance / frameCount) * 4),
            motionEnergy: scaledMotion,
            dominantMotionDirection,
            peakMotionTimestamp: maxMotionTime,
            processed: true
          });

        } catch (e) {
          console.warn("Video analysis failed", e);
          cleanup();
          resolve({ brightness: 0.5, contrast: 0.5, motionEnergy: 0.5, processed: true });
        }
      };

      video.onerror = () => {
        cleanup();
        resolve({ brightness: 0.5, contrast: 0.5, motionEnergy: 0.5, processed: true });
      };
    });
  }

  private analyzeFrame(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    prevData: Uint8ClampedArray | null
  ): Promise<{ brightness: number, variance: number, motion: number, horizontalBias: number, verticalBias: number }> {
    const frame = ctx.getImageData(0, 0, width, height);

    if (this.worker) {
      return new Promise((resolve) => {
        const handler = (e: MessageEvent) => {
          this.worker?.removeEventListener('message', handler);
          resolve(e.data);
        };
        this.worker?.addEventListener('message', handler);

        // Create copies of the data to transfer to the worker
        // We need to copy because transferring detaches the original buffer
        const dataCopy = new Uint8ClampedArray(frame.data);
        const transferList: ArrayBuffer[] = [dataCopy.buffer];
        const message: any = { data: dataCopy, width, height };

        if (prevData) {
          // Copy prevData as well and transfer it
          const prevDataCopy = new Uint8ClampedArray(prevData);
          message.prevData = prevDataCopy;
          transferList.push(prevDataCopy.buffer);
        }

        this.worker?.postMessage(message, transferList);
      });
    }

    // Fallback main thread
    const data = frame.data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      const luminance = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
      sum += luminance;
    }
    const avgBrightness = sum / (data.length / 4);

    let sumDiffSq = 0;
    for (let i = 0; i < data.length; i += 4) {
      const luminance = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
      const diff = luminance - avgBrightness;
      sumDiffSq += diff * diff;
    }
    const variance = sumDiffSq / (data.length / 4);

    let motion = 0;
    if (prevData) {
      for (let i = 0; i < data.length; i += 16) {
        const lum1 = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
        const lum2 = (0.299 * prevData[i] + 0.587 * prevData[i + 1] + 0.114 * prevData[i + 2]);
        motion += Math.abs(lum1 - lum2) / 255;
      }
      motion = motion / (data.length / 16);
    }

    return Promise.resolve({
      brightness: avgBrightness,
      variance,
      motion,
      horizontalBias: 0,
      verticalBias: 0
    });
  }
}

export const videoAnalysisService = new VideoAnalysisService();
