export interface BeatMarker {
  time: number; // Time in seconds
  intensity: number; // 0-1 scale of detected peak
  energy?: number; // Local energy level (for speed ramping)
  isDownbeat?: boolean; // First beat of a bar
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
  motion: number;     // 0-1 (amount of motion/action)
  visualInterest: number; // 0-1 (combined score)
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
  clipScore?: number; // 0-100 match score for beat-clip pairing
  speedMultiplier?: number; // 0.5 = half speed, 2.0 = double speed
}

// Style Presets for one-click editing styles
export interface StylePreset {
  id: string;
  name: string;
  description: string;
  minEnergy: number;
  sensitivity: number;
  speedRamping: boolean;
  filterPreference: 'none' | 'cinematic' | 'vibrant' | 'bw';
  transitionStyle: 'fast' | 'smooth' | 'mixed';
  minSegmentDuration: number;
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