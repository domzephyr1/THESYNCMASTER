import { EnhancedSyncSegment, VideoClip } from '../types';
import { supabaseStorage } from './supabaseStorage';

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
}

interface ShotstackTimeline {
  soundtrack?: {
    src: string;
    effect?: string;
  };
  background: string;
  tracks: { clips: ShotstackClip[] }[];
}

interface ShotstackEdit {
  timeline: ShotstackTimeline;
  output: {
    format: 'mp4';
    size: {
      width: number;
      height: number;
    };
  };
}

export class ShotstackService {
  private apiKey: string = '';

  setApiKey(key: string) {
    this.apiKey = key;
  }

  // Use Vercel API proxy to avoid CORS
  private get proxyUrl() {
    return '/api/shotstack';
  }

  // Build Shotstack timeline from segments
  buildTimeline(
    segments: EnhancedSyncSegment[],
    clipUrls: string[],
    audioUrl: string
  ): ShotstackEdit {
    // Build video clips for timeline
    const videoClips: ShotstackClip[] = segments.map((segment) => ({
      asset: {
        type: 'video' as const,
        src: clipUrls[segment.videoIndex],
        trim: segment.clipStartTime,
        volume: 0
      },
      start: segment.startTime,
      length: segment.duration,
      fit: 'crop' as const
    }));

    return {
      timeline: {
        soundtrack: {
          src: audioUrl,
          effect: 'fadeOut'
        },
        background: '#000000',
        tracks: [{ clips: videoClips }]
      },
      output: {
        format: 'mp4',
        size: {
          width: 1280,
          height: 720
        }
      }
    };
  }

  // Submit render job
  async submitRender(edit: ShotstackEdit): Promise<string> {
    console.log('Submitting to Shotstack:', JSON.stringify(edit, null, 2));

    const res = await fetch(`${this.proxyUrl}/render`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(edit)
    });

    if (!res.ok) {
      const error = await res.json();
      console.error('Render submit error:', error);
      throw new Error(error.response?.message || error.error || 'Failed to submit render');
    }

    const data = await res.json();
    return data.response.id;
  }

  // Check render status
  async checkStatus(renderId: string): Promise<{ status: string; url?: string }> {
    const res = await fetch(`${this.proxyUrl}/render?id=${renderId}`, {
      headers: { 'x-api-key': this.apiKey }
    });

    if (!res.ok) {
      throw new Error('Failed to check status');
    }

    const data = await res.json();
    return {
      status: data.response.status,
      url: data.response.url
    };
  }

  // Main export function
  async exportVideo(
    audioFile: File,
    segments: EnhancedSyncSegment[],
    videoClips: VideoClip[],
    onProgress: (progress: number, status: string) => void
  ): Promise<string> {
    if (!this.apiKey) {
      throw new Error('Shotstack API key not set');
    }

    if (!supabaseStorage.isConfigured()) {
      throw new Error('Supabase not configured');
    }

    console.log('=== CLOUD EXPORT STARTING ===');
    console.log(`Segments: ${segments.length}, Clips: ${videoClips.length}`);

    // Step 1: Upload audio to Supabase
    onProgress(0.05, 'Uploading audio...');
    const audioUrl = await supabaseStorage.uploadFile(audioFile, 'audio');

    // Step 2: Upload video clips to Supabase
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
        throw new Error(`Clip ${clipIndex + 1} has no file`);
      }

      const url = await supabaseStorage.uploadFile(clip.file, 'video');
      clipUrls[clipIndex] = url;
    }

    // Step 3: Build and submit render
    onProgress(0.55, 'Submitting render job...');
    const edit = this.buildTimeline(segments, clipUrls, audioUrl);
    const renderId = await this.submitRender(edit);
    console.log('Render ID:', renderId);

    // Step 4: Poll for completion
    const statusLabels: Record<string, string> = {
      'queued': 'Queued...',
      'fetching': 'Fetching assets...',
      'rendering': 'Rendering video...',
      'saving': 'Saving...',
      'done': 'Complete!'
    };

    while (true) {
      const { status, url } = await this.checkStatus(renderId);
      console.log('Status:', status);

      const progressMap: Record<string, number> = {
        'queued': 0.6,
        'fetching': 0.65,
        'rendering': 0.75,
        'saving': 0.9,
        'done': 1.0
      };

      onProgress(progressMap[status] || 0.6, statusLabels[status] || status);

      if (status === 'done' && url) {
        console.log('=== EXPORT COMPLETE ===');
        console.log('Video URL:', url);
        return url;
      }

      if (status === 'failed') {
        throw new Error('Render failed');
      }

      // Wait 3 seconds before polling again
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

export const shotstackService = new ShotstackService();
