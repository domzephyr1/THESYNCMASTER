export interface BeatMarker {
  time: number; // Time in seconds
  intensity: number; // 0-1 scale of detected peak
}

export enum TransitionType {
  CUT = 'CUT',
  CROSSFADE = 'CROSSFADE',
  ZOOM = 'ZOOM',
  GLITCH = 'GLITCH' // Replaces 'whip' for cyber theme
}

export interface ClipMetadata {
  brightness: number; // 0-1
  contrast: number;   // 0-1 (measure of variance)
  processed: boolean;
}

export interface SyncSegment {
  startTime: number;
  endTime: number;
  duration: number;
  videoIndex: number; // Which video clip to play
  clipStartTime: number; // The specific timestamp in the video file to start playing from
  transition: TransitionType;
  prevVideoIndex: number; // Required for crossfades
}

export interface EnhancedSyncSegment extends SyncSegment {
  filter: 'none' | 'bw' | 'contrast' | 'cyber';
}

export interface VideoClip {
  id: string;
  file: File;
  url: string;
  duration: number;
  name: string;
  trimStart: number;
  trimEnd: number;
  metadata?: ClipMetadata;
}

export enum AppStep {
  UPLOAD = 'UPLOAD',
  ANALYZING = 'ANALYZING',
  PREVIEW = 'PREVIEW',
  EXPORT = 'EXPORT'
}

export interface ExportConfig {
  apiKey: string;
  format: '1080p' | '720p';
}