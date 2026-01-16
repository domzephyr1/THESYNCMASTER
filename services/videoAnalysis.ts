import { ClipMetadata } from '../types';

// Inline worker code for analyzing pixel data
// This avoids needing a separate file build process for the worker
const workerCode = `
self.onmessage = function(e) {
  const { data, width, height, prevData } = e.data;
  let sum = 0;

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

  // Calculate Motion (difference from previous frame)
  let motion = 0;
  if (prevData && prevData.length === data.length) {
    let diffSum = 0;
    for (let i = 0; i < data.length; i += 4) {
      const currLum = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
      const prevLum = (0.299 * prevData[i] + 0.587 * prevData[i + 1] + 0.114 * prevData[i + 2]) / 255;
      diffSum += Math.abs(currLum - prevLum);
    }
    motion = diffSum / (data.length / 4);
  }

  self.postMessage({ brightness: avgBrightness, variance, motion });
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
        resolve({ brightness: 0.5, contrast: 0.5, motion: 0.5, visualInterest: 0.5, processed: true });
        return;
      }

      video.onloadedmetadata = async () => {
        canvas.width = 160;
        canvas.height = 90;

        try {
          // Sample more frames for motion detection
          const sampleCount = 6;
          const samples = Array.from({ length: sampleCount }, (_, i) =>
            ((i + 1) / (sampleCount + 1)) * video.duration
          );

          let totalBrightness = 0;
          let totalVariance = 0;
          let totalMotion = 0;
          let prevFrameData: Uint8ClampedArray | null = null;

          for (const time of samples) {
             video.currentTime = time;
             // Wait for seek with timeout to prevent hanging
             await new Promise<void>(r => {
                 const timeout = setTimeout(() => {
                     video.removeEventListener('seeked', onSeek);
                     r(); // Resolve anyway after timeout
                 }, 2000);
                 const onSeek = () => {
                     clearTimeout(timeout);
                     video.removeEventListener('seeked', onSeek);
                     r();
                 };
                 video.addEventListener('seeked', onSeek);
             });

             ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

             // Analyze with motion detection
             const result = await this.analyzeFrame(ctx, canvas.width, canvas.height, prevFrameData);

             totalBrightness += result.brightness;
             totalVariance += result.variance;
             totalMotion += result.motion;

             // Store current frame for next motion comparison
             prevFrameData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          }

          const avgBrightness = totalBrightness / samples.length;
          const avgContrast = Math.min(1, (totalVariance / samples.length) * 4);
          const avgMotion = Math.min(1, (totalMotion / (samples.length - 1)) * 5); // Scale motion

          // Calculate visual interest score (combination of factors)
          const visualInterest = (
            avgContrast * 0.3 +           // High contrast = interesting
            avgMotion * 0.4 +             // Motion = engaging
            (1 - Math.abs(avgBrightness - 0.5)) * 0.3  // Not too dark/bright
          );

          resolve({
             brightness: avgBrightness,
             contrast: avgContrast,
             motion: avgMotion,
             visualInterest: Math.min(1, visualInterest),
             processed: true
          });

        } catch (e) {
            console.warn("Video analysis failed", e);
            resolve({ brightness: 0.5, contrast: 0.5, motion: 0.5, visualInterest: 0.5, processed: true });
        }
      };

      video.onerror = () => {
         resolve({ brightness: 0.5, contrast: 0.5, motion: 0.5, visualInterest: 0.5, processed: true });
      };
    });
  }

  private analyzeFrame(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    prevFrameData: Uint8ClampedArray | null = null
  ): Promise<{brightness: number, variance: number, motion: number}> {
      const frame = ctx.getImageData(0, 0, width, height);

      // Use Worker
      if (this.worker) {
          return new Promise((resolve) => {
             const handler = (e: MessageEvent) => {
                 this.worker?.removeEventListener('message', handler);
                 resolve(e.data);
             };
             this.worker?.addEventListener('message', handler);
             this.worker?.postMessage({
                 data: frame.data,
                 width,
                 height,
                 prevData: prevFrameData
             }, [frame.data.buffer]); // Transferable
          });
      }

      // Fallback Main Thread
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

      // Calculate motion
      let motion = 0;
      if (prevFrameData && prevFrameData.length === data.length) {
        let diffSum = 0;
        for (let i = 0; i < data.length; i += 4) {
          const currLum = (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) / 255;
          const prevLum = (0.299 * prevFrameData[i] + 0.587 * prevFrameData[i + 1] + 0.114 * prevFrameData[i + 2]) / 255;
          diffSum += Math.abs(currLum - prevLum);
        }
        motion = diffSum / (data.length / 4);
      }

      return Promise.resolve({ brightness: avgBrightness, variance, motion });
  }
}

export const videoAnalysisService = new VideoAnalysisService();