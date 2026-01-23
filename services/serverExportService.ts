import { EnhancedSyncSegment, VideoClip } from '../types';

const SERVER_URL = 'http://localhost:3001';

export class ServerExportService {
  private sessionId: string;

  constructor() {
    this.sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  async checkServer(): Promise<boolean> {
    try {
      const res = await fetch(`${SERVER_URL}/api/health`);
      return res.ok;
    } catch {
      return false;
    }
  }

  async exportVideo(
    audioFile: File,
    segments: EnhancedSyncSegment[],
    videoClips: VideoClip[],
    onProgress: (progress: number) => void
  ): Promise<Blob> {
    console.log('========================================');
    console.log('SERVER EXPORT STARTING');
    console.log('========================================');
    console.log(`Segments: ${segments.length}`);
    console.log(`Clips: ${videoClips.length}`);
    console.log(`Audio: ${audioFile.name}`);

    const headers = { 'x-session-id': this.sessionId };

    // 1. Upload all video clips
    console.log('\n--- Uploading video clips ---');
    const clipFiles: string[] = [];
    const usedClipIndices = [...new Set(segments.map(s => s.videoIndex))];

    for (let i = 0; i < usedClipIndices.length; i++) {
      const clipIndex = usedClipIndices[i];
      const clip = videoClips[clipIndex];

      if (!clip.file) {
        throw new Error(`Clip ${clipIndex + 1} has no file data`);
      }

      const formData = new FormData();
      formData.append('clip', clip.file, `clip_${clipIndex}.mp4`);

      console.log(`Uploading clip ${clipIndex + 1}/${videoClips.length}: ${clip.name}`);

      const res = await fetch(`${SERVER_URL}/api/upload-clip`, {
        method: 'POST',
        headers,
        body: formData
      });

      if (!res.ok) {
        throw new Error(`Failed to upload clip ${clipIndex + 1}`);
      }

      const data = await res.json();
      clipFiles[clipIndex] = data.filename;

      onProgress((i + 1) / (usedClipIndices.length + 2) * 0.3);
    }

    // 2. Upload audio
    console.log('\n--- Uploading audio ---');
    const audioFormData = new FormData();
    audioFormData.append('audio', audioFile, 'audio.mp3');

    const audioRes = await fetch(`${SERVER_URL}/api/upload-audio`, {
      method: 'POST',
      headers,
      body: audioFormData
    });

    if (!audioRes.ok) {
      throw new Error('Failed to upload audio');
    }

    const audioData = await audioRes.json();
    onProgress(0.35);

    // 3. Request export
    console.log('\n--- Requesting export ---');
    const exportRes = await fetch(`${SERVER_URL}/api/export`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        segments: segments.map(s => ({
          videoIndex: s.videoIndex,
          clipStartTime: s.clipStartTime,
          duration: s.duration
        })),
        clipFiles,
        audioFile: audioData.filename
      })
    });

    if (!exportRes.ok) {
      const error = await exportRes.json();
      throw new Error(error.error || 'Export failed');
    }

    onProgress(0.9);

    // 4. Get the blob
    const blob = await exportRes.blob();
    onProgress(1);

    console.log('========================================');
    console.log(`EXPORT COMPLETE: ${(blob.size / 1024 / 1024).toFixed(2)} MB`);
    console.log('========================================');

    return blob;
  }

  async cleanup(): Promise<void> {
    try {
      await fetch(`${SERVER_URL}/api/cleanup`, {
        method: 'POST',
        headers: { 'x-session-id': this.sessionId }
      });
    } catch {
      // Ignore cleanup errors
    }
  }
}

export const serverExportService = new ServerExportService();
