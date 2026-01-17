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

  self.postMessage({
    brightness: avgBrightness,
    variance,
    motion: motionSum,
    horizontalBias: horizontalMotion,
    verticalBias: verticalMotion
  });
};
`;

export class VideoAnalysisService {
  private worker: Worker | null = null;

  constructor() {
    try {
      const blob = new Blob([workerCode], { type: 'application/javascript' });
      this.worker = new Worker(URL.createObjectURL(blob));
    } catch (e) {
      console.warn("Worker creation failed, falling back to main thread", e);
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

      if (!ctx) {
        resolve({ brightness: 0.5, contrast: 0.5, motionEnergy: 0.5, processed: true });
        return;
      }

      video.onloadedmetadata = async () => {
        canvas.width = 160;
        canvas.height = 90;

        try {
          const sampleTimes = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map(p => p * video.duration);

          let totalBrightness = 0;
          let totalVariance = 0;
          let totalMotion = 0;
          let maxMotion = 0;
          let maxMotionTime = 0;
          let horizontalBias = 0;
          let verticalBias = 0;

          let prevFrameData: Uint8ClampedArray | null = null;

          for (let i = 0; i < sampleTimes.length; i++) {
            const time = sampleTimes[i];
            video.currentTime = time;

            await new Promise<void>(r => {
              const onSeek = () => {
                video.removeEventListener('seeked', onSeek);
                r();
              };
              video.addEventListener('seeked', onSeek);
            });

            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const currentFrameData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

            const result = await this.analyzeFrame(
              ctx,
              canvas.width,
              canvas.height,
              prevFrameData
            );

            totalBrightness += result.brightness;
            totalVariance += result.variance;

            if (prevFrameData) {
              totalMotion += result.motion;
              horizontalBias += result.horizontalBias;
              verticalBias += result.verticalBias;

              if (result.motion > maxMotion) {
                maxMotion = result.motion;
                maxMotionTime = time;
              }
            }

            prevFrameData = new Uint8ClampedArray(currentFrameData);
          }

          const frameCount = sampleTimes.length;
          const motionFrameCount = frameCount - 1;

          let dominantMotionDirection: 'static' | 'horizontal' | 'vertical' | 'chaotic' = 'static';
          const avgMotion = totalMotion / motionFrameCount;

          if (avgMotion > 0.1) {
            const hBias = Math.abs(horizontalBias / motionFrameCount);
            const vBias = Math.abs(verticalBias / motionFrameCount);

            if (hBias > vBias * 1.5) dominantMotionDirection = 'horizontal';
            else if (vBias > hBias * 1.5) dominantMotionDirection = 'vertical';
            else if (avgMotion > 0.3) dominantMotionDirection = 'chaotic';
          }

          resolve({
            brightness: totalBrightness / frameCount,
            contrast: Math.min(1, (totalVariance / frameCount) * 4),
            motionEnergy: Math.min(1, avgMotion * 3),
            dominantMotionDirection,
            peakMotionTimestamp: maxMotionTime,
            processed: true
          });

        } catch (e) {
          console.warn("Video analysis failed", e);
          resolve({ brightness: 0.5, contrast: 0.5, motionEnergy: 0.5, processed: true });
        }
      };

      video.onerror = () => {
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

        const transferList: ArrayBuffer[] = [frame.data.buffer];
        const message: any = { data: frame.data, width, height };

        if (prevData) {
          message.prevData = prevData;
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
