import { EnhancedSyncSegment, VideoClip } from '../types';

const SHOTSTACK_API_URL = 'https://api.shotstack.io/v1';
const SHOTSTACK_STAGE_URL = 'https://api.shotstack.io/stage'; // Free sandbox for testing

interface ShotstackClip {
  asset: {
    type: 'video' | 'audio';
    src: string;
    trim?: number;
    volume?: number;
  };
  start: number;
  length: number;
  fit?: 'crop' | 'cover' | 'contain';
  scale?: number;
}

interface ShotstackTrack {
  clips: ShotstackClip[];
}

interface ShotstackTimeline {
  background: string;
  tracks: ShotstackTrack[];
}

interface ShotstackEdit {
  timeline: ShotstackTimeline;
  output: {
    format: 'mp4' | 'gif' | 'webm';
    resolution: 'hd' | 'sd' | '1080' | '720' | '480';
    fps?: number;
  };
}

interface RenderResponse {
  success: boolean;
  message: string;
  response: {
    id: string;
    message: string;
  };
}

interface StatusResponse {
  success: boolean;
  response: {
    id: string;
    status: 'queued' | 'fetching' | 'rendering' | 'saving' | 'done' | 'failed';
    url?: string;
    error?: string;
  };
}

export class ShotstackService {
  private apiKey: string = '';
  private useStage: boolean = true; // Use sandbox by default

  setApiKey(key: string) {
    this.apiKey = key;
  }

  setProduction(isProd: boolean) {
    this.useStage = !isProd;
  }

  private get baseUrl() {
    return this.useStage ? SHOTSTACK_STAGE_URL : SHOTSTACK_API_URL;
  }

  async checkApiKey(): Promise<boolean> {
    if (!this.apiKey) return false;
    try {
      const res = await fetch(`${this.baseUrl}/render`, {
        method: 'GET',
        headers: {
          'x-api-key': this.apiKey,
          'Content-Type': 'application/json'
        }
      });
      // 401 = bad key, 200 or other = key works
      return res.status !== 401;
    } catch {
      return false;
    }
  }

  // Ingest API has a different base URL
  private get ingestUrl() {
    return this.useStage
      ? 'https://api.shotstack.io/ingest/stage'
      : 'https://api.shotstack.io/ingest/v1';
  }

  // Upload a file to get a public URL using Shotstack's Ingest API
  async uploadFile(file: File): Promise<string> {
    console.log(`Uploading file: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);

    // Step 1: Get a signed upload URL from Ingest API
    // IMPORTANT: No body - just headers
    const signedRes = await fetch(`${this.ingestUrl}/upload`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'Accept': 'application/json'
      }
    });

    if (!signedRes.ok) {
      const errorText = await signedRes.text();
      console.error('Signed URL error:', signedRes.status, errorText);
      throw new Error(`Failed to get upload URL: ${signedRes.status}`);
    }

    const signedData = await signedRes.json();
    console.log('Signed URL response:', signedData);

    const uploadUrl = signedData.data?.attributes?.url;
    const sourceId = signedData.data?.id;

    if (!uploadUrl) {
      throw new Error('No upload URL in response');
    }

    // Step 2: Upload the file to the signed URL
    // IMPORTANT: Do NOT include Content-Type header per Shotstack docs
    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      body: file
    });

    if (!uploadRes.ok) {
      throw new Error(`Upload failed: ${uploadRes.status}`);
    }

    console.log(`File uploaded, source ID: ${sourceId}`);

    // Step 3: Wait for the file to be processed and get the final URL
    const sourceUrl = await this.waitForSource(sourceId);
    return sourceUrl;
  }

  // Wait for uploaded file to be processed and return its URL
  async waitForSource(sourceId: string): Promise<string> {
    const maxAttempts = 60; // 3 minutes max

    for (let i = 0; i < maxAttempts; i++) {
      const res = await fetch(`${this.ingestUrl}/sources/${sourceId}`, {
        headers: {
          'x-api-key': this.apiKey,
          'Accept': 'application/json'
        }
      });

      if (!res.ok) {
        throw new Error(`Failed to check source status: ${res.status}`);
      }

      const data = await res.json();
      const status = data.data?.attributes?.status;
      const url = data.data?.attributes?.url;

      console.log(`Source ${sourceId} status: ${status}`);

      if (status === 'ready' && url) {
        return url;
      }

      if (status === 'failed') {
        throw new Error('File processing failed');
      }

      // Wait 3 seconds before checking again
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    throw new Error('Timeout waiting for file to process');
  }

  // Convert our segments to Shotstack timeline format
  buildTimeline(
    segments: EnhancedSyncSegment[],
    clipUrls: string[],
    audioUrl: string,
    audioDuration: number
  ): ShotstackEdit {
    // Build video track with all segments
    const videoClips: ShotstackClip[] = segments.map((segment) => ({
      asset: {
        type: 'video' as const,
        src: clipUrls[segment.videoIndex],
        trim: segment.clipStartTime,
        volume: 0 // Mute original video audio
      },
      start: segment.startTime,
      length: segment.duration,
      fit: 'crop' as const
    }));

    // Audio track
    const audioClips: ShotstackClip[] = [{
      asset: {
        type: 'audio' as const,
        src: audioUrl,
        volume: 1
      },
      start: 0,
      length: audioDuration
    }];

    return {
      timeline: {
        background: '#000000',
        tracks: [
          { clips: videoClips }, // Video on top track
          { clips: audioClips }  // Audio on bottom track
        ]
      },
      output: {
        format: 'mp4',
        resolution: 'hd', // 1280x720
        fps: 30
      }
    };
  }

  async submitRender(edit: ShotstackEdit): Promise<string> {
    console.log('Submitting render to Shotstack:', JSON.stringify(edit, null, 2));

    const res = await fetch(`${this.baseUrl}/render`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(edit)
    });

    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.message || 'Failed to submit render');
    }

    const data: RenderResponse = await res.json();
    return data.response.id;
  }

  async checkRenderStatus(renderId: string): Promise<StatusResponse['response']> {
    const res = await fetch(`${this.baseUrl}/render/${renderId}`, {
      headers: {
        'x-api-key': this.apiKey
      }
    });

    if (!res.ok) {
      throw new Error('Failed to check render status');
    }

    const data: StatusResponse = await res.json();
    return data.response;
  }

  async waitForRender(
    renderId: string,
    onProgress: (status: string, progress: number) => void
  ): Promise<string> {
    const progressMap: Record<string, number> = {
      'queued': 0.1,
      'fetching': 0.2,
      'rendering': 0.5,
      'saving': 0.9,
      'done': 1.0
    };

    while (true) {
      const status = await this.checkRenderStatus(renderId);

      const progress = progressMap[status.status] || 0;
      onProgress(status.status, progress);

      if (status.status === 'done' && status.url) {
        return status.url;
      }

      if (status.status === 'failed') {
        throw new Error(status.error || 'Render failed');
      }

      // Poll every 3 seconds
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  }

  async exportVideo(
    audioFile: File,
    segments: EnhancedSyncSegment[],
    videoClips: VideoClip[],
    onProgress: (progress: number, status: string) => void
  ): Promise<string> {
    if (!this.apiKey) {
      throw new Error('Shotstack API key not set');
    }

    console.log('========================================');
    console.log('SHOTSTACK CLOUD EXPORT STARTING');
    console.log('========================================');
    console.log(`Mode: ${this.useStage ? 'Sandbox (free)' : 'Production'}`);
    console.log(`Segments: ${segments.length}`);
    console.log(`Clips: ${videoClips.length}`);

    onProgress(0.05, 'Uploading audio...');

    // 1. Upload audio file
    const audioUrl = await this.uploadFile(audioFile);
    console.log('Audio uploaded:', audioUrl);

    // Get audio duration
    const audioDuration = segments.length > 0
      ? segments[segments.length - 1].endTime
      : 60;

    // 2. Upload video clips (only the ones used)
    const usedClipIndices = [...new Set(segments.map(s => s.videoIndex))];
    const clipUrls: string[] = [];

    for (let i = 0; i < usedClipIndices.length; i++) {
      const clipIndex = usedClipIndices[i];
      const clip = videoClips[clipIndex];

      onProgress(
        0.1 + (i / usedClipIndices.length) * 0.4,
        `Uploading clip ${i + 1}/${usedClipIndices.length}...`
      );

      if (!clip.file) {
        throw new Error(`Clip ${clipIndex + 1} has no file data`);
      }

      const url = await this.uploadFile(clip.file);
      clipUrls[clipIndex] = url;
      console.log(`Clip ${clipIndex + 1} uploaded:`, url);
    }

    onProgress(0.5, 'Building timeline...');

    // 3. Build Shotstack timeline
    const edit = this.buildTimeline(segments, clipUrls, audioUrl, audioDuration);

    onProgress(0.55, 'Submitting render...');

    // 4. Submit render job
    const renderId = await this.submitRender(edit);
    console.log('Render submitted, ID:', renderId);

    // 5. Wait for completion
    const videoUrl = await this.waitForRender(renderId, (status, progress) => {
      const statusLabels: Record<string, string> = {
        'queued': 'Queued...',
        'fetching': 'Fetching assets...',
        'rendering': 'Rendering video...',
        'saving': 'Saving...',
        'done': 'Complete!'
      };
      onProgress(0.55 + progress * 0.45, statusLabels[status] || status);
    });

    console.log('========================================');
    console.log('SHOTSTACK EXPORT COMPLETE');
    console.log('Video URL:', videoUrl);
    console.log('========================================');

    return videoUrl;
  }
}

export const shotstackService = new ShotstackService();
