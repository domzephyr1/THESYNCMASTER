import { StylePreset, TransitionType } from '../types';

export const STYLE_PRESETS: Record<string, StylePreset> = {
  hype: {
    id: 'hype',
    name: 'Hype Edit',
    description: 'Fast cuts, high energy, maximum impact',
    minEnergy: 0.05,
    sensitivity: 3.5,
    speedRamping: true,
    minSegmentBeats: 1,
    maxSegmentBeats: 2,
    transitionWeights: {
      [TransitionType.CUT]: 0.4,
      [TransitionType.CROSSFADE]: 0.0,
      [TransitionType.ZOOM]: 0.2,
      [TransitionType.GLITCH]: 0.2,
      [TransitionType.WHIP]: 0.1,
      [TransitionType.FLASH]: 0.1,
      [TransitionType.IMPACT]: 0.0
    }
  },
  cinematic: {
    id: 'cinematic',
    name: 'Cinematic',
    description: 'Smooth transitions, dramatic pacing',
    minEnergy: 0.4,
    sensitivity: 1.5,
    speedRamping: true,
    minSegmentBeats: 4,
    maxSegmentBeats: 8,
    transitionWeights: {
      [TransitionType.CUT]: 0.3,
      [TransitionType.CROSSFADE]: 0.5,
      [TransitionType.ZOOM]: 0.2,
      [TransitionType.GLITCH]: 0.0,
      [TransitionType.WHIP]: 0.0,
      [TransitionType.FLASH]: 0.0,
      [TransitionType.IMPACT]: 0.0
    }
  },
  chill: {
    id: 'chill',
    name: 'Chill Vibes',
    description: 'Relaxed cuts, longer holds',
    minEnergy: 0.5,
    sensitivity: 1.0,
    speedRamping: false,
    minSegmentBeats: 6,
    maxSegmentBeats: 12,
    transitionWeights: {
      [TransitionType.CUT]: 0.3,
      [TransitionType.CROSSFADE]: 0.7,
      [TransitionType.ZOOM]: 0.0,
      [TransitionType.GLITCH]: 0.0,
      [TransitionType.WHIP]: 0.0,
      [TransitionType.FLASH]: 0.0,
      [TransitionType.IMPACT]: 0.0
    }
  },
  musicVideo: {
    id: 'musicVideo',
    name: 'Music Video',
    description: 'Balanced cuts synced to rhythm',
    minEnergy: 0.2,
    sensitivity: 2.0,
    speedRamping: true,
    minSegmentBeats: 2,
    maxSegmentBeats: 8,
    transitionWeights: {
      [TransitionType.CUT]: 0.5,
      [TransitionType.CROSSFADE]: 0.2,
      [TransitionType.ZOOM]: 0.1,
      [TransitionType.GLITCH]: 0.1,
      [TransitionType.WHIP]: 0.05,
      [TransitionType.FLASH]: 0.05,
      [TransitionType.IMPACT]: 0.0
    }
  },
  aggressive: {
    id: 'aggressive',
    name: 'Aggressive',
    description: 'Rapid fire cuts, intense energy',
    minEnergy: 0.02,
    sensitivity: 4.0,
    speedRamping: true,
    minSegmentBeats: 1,
    maxSegmentBeats: 1,
    transitionWeights: {
      [TransitionType.CUT]: 0.6,
      [TransitionType.CROSSFADE]: 0.0,
      [TransitionType.ZOOM]: 0.1,
      [TransitionType.GLITCH]: 0.2,
      [TransitionType.WHIP]: 0.05,
      [TransitionType.FLASH]: 0.05,
      [TransitionType.IMPACT]: 0.0
    }
  },
  gentle: {
    id: 'gentle',
    name: 'Gentle',
    description: 'Minimal cuts, focus on content',
    minEnergy: 0.6,
    sensitivity: 1.2,
    speedRamping: false,
    minSegmentBeats: 8,
    maxSegmentBeats: 16,
    transitionWeights: {
      [TransitionType.CUT]: 0.2,
      [TransitionType.CROSSFADE]: 0.8,
      [TransitionType.ZOOM]: 0.0,
      [TransitionType.GLITCH]: 0.0,
      [TransitionType.WHIP]: 0.0,
      [TransitionType.FLASH]: 0.0,
      [TransitionType.IMPACT]: 0.0
    }
  }
};

export const getPresetList = (): StylePreset[] => Object.values(STYLE_PRESETS);

export const getPresetById = (id: string): StylePreset | undefined => STYLE_PRESETS[id];
