import { StylePreset } from '../types';

export const STYLE_PRESETS: Record<string, StylePreset> = {
  hype: {
    id: 'hype',
    name: 'Hype Edit',
    description: 'Fast cuts, high energy, maximum impact',
    minEnergy: 0.05,
    sensitivity: 3.5,
    speedRamping: true,
    filterPreference: 'vibrant',
    transitionStyle: 'fast',
    minSegmentDuration: 0.4
  },
  cinematic: {
    id: 'cinematic',
    name: 'Cinematic',
    description: 'Smooth transitions, dramatic pacing',
    minEnergy: 0.4,
    sensitivity: 1.5,
    speedRamping: true,
    filterPreference: 'cinematic',
    transitionStyle: 'smooth',
    minSegmentDuration: 2.0
  },
  chill: {
    id: 'chill',
    name: 'Chill Vibes',
    description: 'Relaxed cuts, longer holds',
    minEnergy: 0.5,
    sensitivity: 1.0,
    speedRamping: false,
    filterPreference: 'none',
    transitionStyle: 'smooth',
    minSegmentDuration: 3.0
  },
  musicVideo: {
    id: 'musicVideo',
    name: 'Music Video',
    description: 'Balanced cuts synced to rhythm',
    minEnergy: 0.2,
    sensitivity: 2.5,
    speedRamping: true,
    filterPreference: 'none',
    transitionStyle: 'mixed',
    minSegmentDuration: 1.0
  },
  aggressive: {
    id: 'aggressive',
    name: 'Aggressive',
    description: 'Rapid fire cuts, intense energy',
    minEnergy: 0.02,
    sensitivity: 4.0,
    speedRamping: true,
    filterPreference: 'vibrant',
    transitionStyle: 'fast',
    minSegmentDuration: 0.3
  },
  gentle: {
    id: 'gentle',
    name: 'Gentle',
    description: 'Minimal cuts, focus on content',
    minEnergy: 0.6,
    sensitivity: 1.2,
    speedRamping: false,
    filterPreference: 'none',
    transitionStyle: 'smooth',
    minSegmentDuration: 4.0
  }
};

export const getPresetList = (): StylePreset[] => Object.values(STYLE_PRESETS);

export const getPresetById = (id: string): StylePreset | undefined => STYLE_PRESETS[id];
