import { ClipMetadata } from '../types';

// Inline worker code for analyzing pixel data
// This avoids needing a separate file build process for the worker
const workerCode = `
self.onmessage = function(e) {
  const { data, width, height } = e.data;
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

  self.postMessage({ brightness: avgBrightness, variance });
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
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.src = videoUrl;
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = "anonymous";

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { willReadFrequently: true });

      if (!ctx) {
        resolve({ brightness: 0.5, contrast: 0.5, processed: true });
        return;
      }

      video.onloadedmetadata = async () => {
        canvas.width = 160; 
        canvas.height = 90;

        try {
          const samples = [0.2, 0.5, 0.8].map(p => p * video.duration);
          let totalBrightness = 0;
          let totalVariance = 0;

          for (const time of samples) {
             video.currentTime = time;
             await new Promise<void>(r => {
                 const onSeek = () => {
                     video.removeEventListener('seeked', onSeek);
                     r();
                 };
                 video.addEventListener('seeked', onSeek);
             });
             
             ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
             
             // Offload math to worker if available
             const { brightness, variance } = await this.analyzeFrame(ctx, canvas.width, canvas.height);
             
             totalBrightness += brightness;
             totalVariance += variance;
          }

          resolve({
             brightness: totalBrightness / samples.length,
             contrast: Math.min(1, (totalVariance / samples.length) * 4), 
             processed: true
          });

        } catch (e) {
            console.warn("Video analysis failed", e);
            resolve({ brightness: 0.5, contrast: 0.5, processed: true });
        }
      };

      video.onerror = () => {
         resolve({ brightness: 0.5, contrast: 0.5, processed: true });
      };
    });
  }

  private analyzeFrame(ctx: CanvasRenderingContext2D, width: number, height: number): Promise<{brightness: number, variance: number}> {
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
                 height 
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

      return Promise.resolve({ brightness: avgBrightness, variance });
  }
}

export const videoAnalysisService = new VideoAnalysisService();