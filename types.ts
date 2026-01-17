export interface BeatMarker {
  time: number;
  intensity: number; // 0-1 scale
  isDownbeat?: boolean; // First beat of a bar
  barPosition?: number; // 1-4 for 4/4 time
  phrasePosition?: number; // Position in 8 or 16 bar phrase
  isDrop?: boolean; // Energy spike after buildup
  isHeroMoment?: boolean; // Protected "money shot" moment
}

export enum TransitionType {
  CUT = 'CUT',
  CROSSFADE = 'CROSSFADE',
  ZOOM = 'ZOOM',
  GLITCH = 'GLITCH',
  WHIP = 'WHIP', // Fast horizontal swipe
  FLASH = 'FLASH', // White flash on impact
  IMPACT = 'IMPACT' // Zoom + flash combo for drops
}

export interface ClipMetadata {
  brightness: number;
  contrast: number;
  motionEnergy: number; // 0-1 motion intensity
  dominantMotionDirection?: 'static' | 'horizontal' | 'vertical' | 'chaotic';
  peakMotionTimestamp?: number; // Where the most action happens
  processed: boolean;
}

export interface SyncSegment {
  startTime: number;
  endTime: number;
  duration: number;
  videoIndex: number;
  clipStartTime: number;
  transition: TransitionType;
  prevVideoIndex: number;
}

export interface EnhancedSyncSegment extends SyncSegment {
  filter: 'none' | 'bw' | 'contrast' | 'cyber' | 'saturate' | 'warm';
  isHeroSegment: boolean;
  isDropSegment: boolean;
  rapidFireGroup?: number;
  holdDuration?: number;
  playbackSpeed?: number; // For speed ramping
  syncScore?: number; // Quality score for this segment
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
  isHeroClip?: boolean;
}

export interface PreloadState {
  clipIndex: number;
  seekTime: number;
  ready: boolean;
}

export interface DropZone {
  startTime: number;
  peakTime: number;
  endTime: number;
  intensity: number;
}

export interface PhraseData {
  barDuration: number;
  phraseBars: number;
  downbeats: number[];
  drops: DropZone[];
}

export enum AppStep {
  UPLOAD = 'UPLOAD',
  ANALYZING = 'ANALYZING',
  PREVIEW = 'PREVIEW',
  EXPORT = 'EXPORT'
}

export interface StylePreset {
  id: string;
  name: string;
  description: string;
  minEnergy: number;
  sensitivity: number;
  speedRamping: boolean;
  minSegmentBeats: number;
  maxSegmentBeats: number;
  transitionWeights: Record<TransitionType, number>;
}

export interface ExportConfig {
  apiKey: string;
  format: '1080p' | '720p';
}

export interface MontageOptions {
  enableSpeedRamping?: boolean;
  enableSmartReorder?: boolean;
  preset?: StylePreset;
  phraseData?: PhraseData;
}

export interface MontageResult {
  segments: EnhancedSyncSegment[];
  bpm: number;
  averageScore: number;
  dropCount: number;
  heroCount: number;
}
