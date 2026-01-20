// ============================================
// SYNCMASTER CONFIGURATION CONSTANTS
// ============================================

// --- Beat Detection ---
export const BEAT_DETECTION = {
  /** Threshold for matching nearby beats (seconds) */
  NEARBY_BEAT_THRESHOLD: 0.15,
  /** Minimum duration for a segment during drops (seconds) */
  MIN_DROP_SEGMENT_DURATION: 0.12,
  /** Minimum duration for a segment normally (seconds) */
  MIN_SEGMENT_DURATION: 0.2,
  /** Window size for drop detection (beats) */
  DROP_DETECTION_WINDOW: 8,
  /** Minimum gap between detected drops (seconds) */
  MIN_DROP_GAP: 8,
} as const;

// --- Video Analysis ---
export const VIDEO_ANALYSIS = {
  /** Canvas width for analysis (smaller = faster) */
  ANALYSIS_WIDTH: 160,
  /** Canvas height for analysis */
  ANALYSIS_HEIGHT: 90,
  /** Time offset between frames for motion detection (seconds) */
  MOTION_SAMPLE_OFFSET: 0.1,
  /** Sample positions through video (0-1) */
  SAMPLE_POSITIONS: [0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9],
  /** Multiplier for motion energy normalization */
  MOTION_ENERGY_MULTIPLIER: 3,
  /** Multiplier for contrast normalization */
  CONTRAST_MULTIPLIER: 4,
} as const;

// --- Playback & Animation ---
export const PLAYBACK = {
  /** Decay rate for flash effect (0-1) */
  FLASH_DECAY_RATE: 0.85,
  /** Decay rate for zoom effect (0-1) */
  ZOOM_DECAY_RATE: 0.95,
  /** Threshold below which zoom resets to 1.0 */
  ZOOM_RESET_THRESHOLD: 1.001,
  /** Maximum drift before forcing video sync correction (seconds) */
  MAX_DRIFT_TOLERANCE: 0.3,
  /** Loop sync tolerance (seconds) */
  LOOP_SYNC_TOLERANCE: 0.15,
  /** Time before cut to start preloading next clip (seconds) */
  PRELOAD_LOOKAHEAD: 0.5,
  /** Crossfade transition duration (seconds) */
  CROSSFADE_DURATION: 0.5,
} as const;

// --- Clip Selection ---
export const CLIP_SELECTION = {
  /** Penalty for using same clip as previous segment (very high to prevent back-to-back) */
  SAME_CLIP_PENALTY: 200,
  /** Time window to penalize recently used clips (seconds) */
  RECENT_USE_WINDOW: 15,
  /** Penalty multiplier for recent use */
  RECENT_USE_PENALTY_MULTIPLIER: 15,
  /** Penalty per use count (higher = more variety) */
  OVERUSE_PENALTY: 20,
  /** Bonus for motion matching */
  MOTION_MATCH_BONUS: 25,
  /** Bonus for hero clips at hero moments */
  HERO_CLIP_BONUS: 35,
  /** Bonus for high-motion clips during drops */
  DROP_HIGH_MOTION_BONUS: 30,
  /** Bonus for brightness similarity (smart reorder) */
  BRIGHTNESS_SIMILARITY_BONUS: 15,
  /** Percentage of clips to consider as top candidates (lower = more selective) */
  TOP_CANDIDATES_PERCENTAGE: 0.25,
  /** Minimum top candidates to consider */
  MIN_TOP_CANDIDATES: 3,
} as const;

// --- Speed Ramping ---
export const SPEED_RAMPING = {
  /** Base speed for high energy/drops */
  HIGH_ENERGY_BASE_SPEED: 1.15,
  /** Additional speed multiplier based on intensity for high energy */
  HIGH_ENERGY_INTENSITY_MULTIPLIER: 0.15,
  /** Base speed for low energy (slow-mo) */
  LOW_ENERGY_BASE_SPEED: 0.6,
  /** Additional speed multiplier based on intensity for low energy */
  LOW_ENERGY_INTENSITY_MULTIPLIER: 0.5,
  /** Intensity threshold for high energy */
  HIGH_ENERGY_THRESHOLD: 0.7,
  /** Intensity threshold for low energy */
  LOW_ENERGY_THRESHOLD: 0.4,
} as const;

// --- Sync Scoring ---
export const SYNC_SCORING = {
  /** Base score for all segments */
  BASE_SCORE: 50,
  /** Maximum bonus from motion matching */
  MOTION_MATCH_MAX_BONUS: 30,
  /** Bonus for high-motion clip during drop */
  DROP_HIGH_MOTION_BONUS: 15,
  /** Bonus for hero clip at hero moment */
  HERO_MOMENT_BONUS: 20,
  /** Motion threshold for drop bonus */
  DROP_MOTION_THRESHOLD: 0.6,
} as const;

// --- Timeouts ---
export const TIMEOUTS = {
  /** Delay for state propagation after pause (ms) */
  PAUSE_PROPAGATION_DELAY: 150,
  /** Timeout for video metadata loading (ms) */
  VIDEO_METADATA_TIMEOUT: 5000,
  /** Timeout for video prebuffering per clip (ms) */
  PREBUFFER_TIMEOUT: 3000,
  /** Duration for beat preview playback (ms) */
  BEAT_PREVIEW_DURATION: 2000,
  /** Delay before starting recording (ms) */
  RECORDING_START_DELAY: 500,
  /** Preload timeout fallback (ms) */
  PRELOAD_TIMEOUT: 300,
  /** Toast notification default duration (ms) */
  TOAST_DEFAULT_DURATION: 2500,
  /** Toast long duration (ms) */
  TOAST_LONG_DURATION: 4000,
} as const;

// --- FFmpeg Export ---
export const FFMPEG_EXPORT = {
  /** Batch size for segment processing */
  BATCH_SIZE: 25,
  /** Output video width */
  OUTPUT_WIDTH: 1280,
  /** Output video height */
  OUTPUT_HEIGHT: 720,
  /** Output frame rate */
  OUTPUT_FPS: 30,
  /** CRF quality (lower = better quality, higher file size) */
  CRF_QUALITY: 28,
  /** Audio bitrate */
  AUDIO_BITRATE: '192k',
} as const;

// --- BPM Calculation ---
export const BPM = {
  /** Minimum samples for BPM calculation */
  MIN_SAMPLES: 4,
  /** Default BPM when calculation fails */
  DEFAULT_BPM: 120,
  /** Maximum samples to use for BPM calculation */
  MAX_SAMPLES: 50,
  /** Variance tolerance for filtering outliers */
  VARIANCE_TOLERANCE: 0.3,
  /** Minimum BPM (will double if below) */
  MIN_BPM: 80,
  /** Maximum BPM (will halve if above) */
  MAX_BPM: 180,
} as const;
