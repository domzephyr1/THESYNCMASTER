import { BeatMarker, EnhancedSyncSegment, TransitionType, VideoClip, DropZone, PhraseData, MontageOptions, MontageResult, StylePreset } from '../types';
import {
  BEAT_DETECTION,
  CLIP_SELECTION,
  SPEED_RAMPING,
  SYNC_SCORING,
  BPM
} from '../constants';

export class SegmentationService {

  generateMontage(
    beats: BeatMarker[],
    videoClips: VideoClip[],
    duration: number,
    options: MontageOptions = {}
  ): MontageResult {

    if (!beats.length || !videoClips.length || duration === 0) {
      return { segments: [], bpm: 0, averageScore: 0, dropCount: 0, heroCount: 0 };
    }

    const { enableSpeedRamping = false, enableSmartReorder = false, preset, phraseData } = options;

    // --- BPM Calculation ---
    const estimatedBpm = this.calculateBPM(beats);
    const beatDuration = 60 / estimatedBpm;

    // --- Identify Special Zones ---
    const drops = phraseData?.drops || this.inferDrops(beats);
    const heroBeats = beats.filter(b => b.isHeroMoment);

    // --- Reserve Hero Clips ---
    const heroClipIndices = this.selectHeroClips(videoClips);

    // --- Build Segments ---
    const segments: EnhancedSyncSegment[] = [];
    let currentBeatIndex = 0;
    let totalScore = 0;

    // --- Handle Intro Gap (before first beat) ---
    // If first beat doesn't start at 0, create an intro segment
    const firstBeatTime = beats.length > 0 ? beats[0].time : 0;
    if (firstBeatTime > 0.5) { // Only if there's a significant gap (>0.5s)
      // Select a calm clip for the intro (prefer low motion)
      const introClipIndex = this.selectIntroClip(videoClips);
      const introClip = videoClips[introClipIndex];

      const introSegment: EnhancedSyncSegment = {
        startTime: 0,
        endTime: firstBeatTime,
        duration: firstBeatTime,
        videoIndex: introClipIndex,
        clipStartTime: introClip?.trimStart || 0,
        transition: TransitionType.CUT,
        prevVideoIndex: -1,
        filter: 'none',
        isHeroSegment: false,
        isDropSegment: false,
        playbackSpeed: 1.0,
        syncScore: 50 // Neutral score for intro
      };

      segments.push(introSegment);
      totalScore += 50;
      console.log(`📍 Added intro segment: 0s - ${firstBeatTime.toFixed(2)}s (Clip ${introClipIndex + 1})`);
    }

    while (currentBeatIndex < beats.length) {
      const beat = beats[currentBeatIndex];
      const nextBeat = beats[currentBeatIndex + 1];

      let endTime: number;
      if (nextBeat) {
        endTime = nextBeat.time;
      } else {
        endTime = duration;
      }

      // Check zones
      const inDrop = drops.some(d => beat.time >= d.startTime && beat.time <= d.endTime);
      const atDropPeak = drops.some(d => Math.abs(beat.time - d.peakTime) < beatDuration);
      const isHero = beat.isHeroMoment || atDropPeak;

      // --- Determine Cutting Strategy ---
      let segmentBeats = 1;

      if (inDrop && estimatedBpm > 100) {
        // RAPID FIRE MODE
        segmentBeats = 1;
      } else if (beat.intensity < 0.3 && !inDrop) {
        // LOW ENERGY: Hold longer
        segmentBeats = Math.min(4, this.countBeatsUntilEnergyRise(beats, currentBeatIndex, 0.5));
      } else if (beat.isDownbeat && beat.phrasePosition === 1) {
        // PHRASE START
        segmentBeats = 2;
      } else {
        // NORMAL
        segmentBeats = beat.intensity > 0.7 ? 1 : 2;
      }

      // Apply preset constraints
      if (preset) {
        segmentBeats = Math.max(preset.minSegmentBeats, Math.min(preset.maxSegmentBeats, segmentBeats));
      }

      const targetEndIndex = Math.min(currentBeatIndex + segmentBeats, beats.length - 1);
      if (beats[targetEndIndex]) {
        endTime = beats[targetEndIndex].time;
      }

      // Minimum duration
      const minDuration = inDrop ? BEAT_DETECTION.MIN_DROP_SEGMENT_DURATION : BEAT_DETECTION.MIN_SEGMENT_DURATION;
      if (endTime - beat.time < minDuration && nextBeat) {
        endTime = beat.time + minDuration;
      }

      // --- Select Video Clip ---
      const clipSelection = this.selectClipForSegment(
        beat,
        videoClips,
        segments,
        isHero,
        heroClipIndices,
        inDrop,
        enableSmartReorder
      );

      // --- Determine Transition ---
      const transition = this.selectTransition(beat, inDrop, atDropPeak, segments.length, preset);

      // --- Determine Filter ---
      const filter = this.selectFilter(beat, inDrop, transition);

      // --- Calculate Clip Start Time ---
      const clip = videoClips[clipSelection.index];
      const clipStartTime = this.calculateClipStartTime(clip, beat, endTime - beat.time, isHero);

      // --- Speed Ramping ---
      let playbackSpeed = 1.0;
      if (enableSpeedRamping) {
        if (inDrop || beat.intensity > SPEED_RAMPING.HIGH_ENERGY_THRESHOLD) {
          playbackSpeed = SPEED_RAMPING.HIGH_ENERGY_BASE_SPEED + (beat.intensity * SPEED_RAMPING.HIGH_ENERGY_INTENSITY_MULTIPLIER);
        } else if (beat.intensity < SPEED_RAMPING.LOW_ENERGY_THRESHOLD) {
          playbackSpeed = SPEED_RAMPING.LOW_ENERGY_BASE_SPEED + (beat.intensity * SPEED_RAMPING.LOW_ENERGY_INTENSITY_MULTIPLIER);
        }
      }

      // --- Calculate Sync Score ---
      const syncScore = this.calculateSegmentScore(beat, clip, inDrop, isHero);
      totalScore += syncScore;

      // --- Build Segment ---
      const segment: EnhancedSyncSegment = {
        startTime: beat.time,
        endTime,
        duration: endTime - beat.time,
        videoIndex: clipSelection.index,
        clipStartTime,
        transition,
        prevVideoIndex: segments.length > 0 ? segments[segments.length - 1].videoIndex : -1,
        filter,
        isHeroSegment: isHero,
        isDropSegment: inDrop,
        rapidFireGroup: inDrop ? this.getDropIndex(beat.time, drops) : undefined,
        playbackSpeed,
        syncScore
      };

      segments.push(segment);
      currentBeatIndex += segmentBeats;
    }

    // Ensure coverage to end
    if (segments.length > 0 && segments[segments.length - 1].endTime < duration) {
      const lastSeg = segments[segments.length - 1];
      lastSeg.endTime = duration;
      lastSeg.duration = duration - lastSeg.startTime;
    }

    const averageScore = segments.length > 0 ? Math.round(totalScore / segments.length) : 0;

    // Count how many clips have metadata
    const clipsWithMetadata = videoClips.filter(c => c.metadata?.processed).length;
    const speedRampedSegments = segments.filter(s => s.playbackSpeed !== 1.0).length;

    console.log(`🎬 Generated ${segments.length} segments | ${heroBeats.length} hero moments | ${drops.length} drops | Score: ${averageScore}%`);
    console.log(`📊 Clips with AI metadata: ${clipsWithMetadata}/${videoClips.length} | Speed-ramped segments: ${speedRampedSegments}`);

    return {
      segments,
      bpm: estimatedBpm,
      averageScore,
      dropCount: drops.length,
      heroCount: heroBeats.length
    };
  }

  // ============ HELPER METHODS ============

  private calculateBPM(beats: BeatMarker[]): number {
    if (beats.length < BPM.MIN_SAMPLES) return BPM.DEFAULT_BPM;

    const intervals: number[] = [];
    for (let i = 1; i < Math.min(beats.length, BPM.MAX_SAMPLES); i++) {
      intervals.push(beats[i].time - beats[i - 1].time);
    }

    intervals.sort((a, b) => a - b);
    const median = intervals[Math.floor(intervals.length / 2)];
    const filtered = intervals.filter(i => Math.abs(i - median) < median * BPM.VARIANCE_TOLERANCE);
    const avgInterval = filtered.reduce((a, b) => a + b, 0) / filtered.length;

    let bpm = 60 / avgInterval;
    while (bpm < BPM.MIN_BPM) bpm *= 2;
    while (bpm > BPM.MAX_BPM) bpm /= 2;

    return Math.round(bpm);
  }

  private inferDrops(beats: BeatMarker[]): DropZone[] {
    const drops: DropZone[] = [];
    const windowSize = BEAT_DETECTION.DROP_DETECTION_WINDOW;

    for (let i = windowSize; i < beats.length - windowSize; i++) {
      const beforeAvg = beats.slice(i - windowSize, i)
        .reduce((sum, b) => sum + b.intensity, 0) / windowSize;
      const afterAvg = beats.slice(i, i + windowSize)
        .reduce((sum, b) => sum + b.intensity, 0) / windowSize;

      // More lenient: detect energy jumps
      if (beforeAvg < 0.5 && afterAvg > 0.5 && beats[i].intensity > 0.6) {
        const lastDrop = drops[drops.length - 1];
        if (!lastDrop || beats[i].time - lastDrop.peakTime > BEAT_DETECTION.MIN_DROP_GAP) {
          drops.push({
            startTime: beats[Math.max(0, i - 4)].time,
            peakTime: beats[i].time,
            endTime: beats[Math.min(beats.length - 1, i + windowSize)].time,
            intensity: beats[i].intensity
          });
        }
      }
    }

    return drops;
  }

  private selectHeroClips(clips: VideoClip[]): number[] {
    const scored = clips.map((clip, index) => ({
      index,
      score: (clip.metadata?.motionEnergy || 0.5) * 0.6 +
             (clip.metadata?.contrast || 0.5) * 0.4 +
             (clip.isHeroClip ? 1.0 : 0) // User-marked hero clips get priority
    }));

    scored.sort((a, b) => b.score - a.score);
    const heroCount = Math.max(1, Math.floor(clips.length * 0.25));
    return scored.slice(0, heroCount).map(s => s.index);
  }

  // Select a calm clip for intro sections (prefer lower motion)
  private selectIntroClip(clips: VideoClip[]): number {
    if (clips.length === 0) return 0;
    if (clips.length === 1) return 0;

    // Score clips - prefer lower motion and moderate brightness for intros
    const scored = clips.map((clip, index) => ({
      index,
      score: (1 - (clip.metadata?.motionEnergy || 0.5)) * 0.5 + // Prefer calm clips
             (clip.metadata?.brightness || 0.5) * 0.3 + // Prefer visible clips
             Math.random() * 0.2 // Small random factor for variety
    }));

    scored.sort((a, b) => b.score - a.score);

    // Pick from top 3 candidates randomly
    const topCandidates = scored.slice(0, Math.min(3, scored.length));
    return topCandidates[Math.floor(Math.random() * topCandidates.length)].index;
  }

  private selectClipForSegment(
    beat: BeatMarker,
    clips: VideoClip[],
    existingSegments: EnhancedSyncSegment[],
    isHero: boolean,
    heroClipIndices: number[],
    inDrop: boolean,
    enableSmartReorder: boolean
  ): { index: number } {

    const usageCount = new Map<number, number>();
    const lastUsedTime = new Map<number, number>();

    existingSegments.forEach(seg => {
      usageCount.set(seg.videoIndex, (usageCount.get(seg.videoIndex) || 0) + 1);
      lastUsedTime.set(seg.videoIndex, seg.endTime);
    });

    const lastSegment = existingSegments[existingSegments.length - 1];
    const lastUsedIndex = lastSegment?.videoIndex ?? -1;

    // Get the last 4 used indices to prevent repetition patterns
    const recentIndices = existingSegments.slice(-4).map(s => s.videoIndex);

    const scored = clips.map((clip, index) => {
      // Hard block: never use same clip as previous (unless only 1 clip available)
      if (clips.length > 1 && index === lastUsedIndex) {
        return { index, score: -1000 };
      }

      // Hard block: never use clip from 2 segments ago (prevents A-B-A pattern)
      if (clips.length > 2 && recentIndices.length >= 2 && index === recentIndices[recentIndices.length - 2]) {
        return { index, score: -1000 };
      }

      let score = 100;

      // Strong penalty for clip used 3-4 segments ago (prevents A-B-C-A patterns)
      if (clips.length > 3 && recentIndices.length >= 3 && index === recentIndices[recentIndices.length - 3]) {
        score -= 150;
      }
      if (clips.length > 4 && recentIndices.length >= 4 && index === recentIndices[recentIndices.length - 4]) {
        score -= 100;
      }

      // Penalize recent use
      const lastTime = lastUsedTime.get(index) || -Infinity;
      const timeSinceUse = beat.time - lastTime;
      if (timeSinceUse < CLIP_SELECTION.RECENT_USE_WINDOW) {
        score -= (CLIP_SELECTION.RECENT_USE_WINDOW - timeSinceUse) * CLIP_SELECTION.RECENT_USE_PENALTY_MULTIPLIER;
      }

      // Penalize same as previous
      if (index === lastUsedIndex) score -= CLIP_SELECTION.SAME_CLIP_PENALTY;

      // Penalize overuse
      const uses = usageCount.get(index) || 0;
      score -= uses * CLIP_SELECTION.OVERUSE_PENALTY;

      // Motion matching
      if (clip.metadata?.motionEnergy) {
        const motionMatch = 1 - Math.abs(clip.metadata.motionEnergy - beat.intensity);
        score += motionMatch * CLIP_SELECTION.MOTION_MATCH_BONUS;
      }

      // Hero clip bonus
      if (isHero && heroClipIndices.includes(index)) {
        score += CLIP_SELECTION.HERO_CLIP_BONUS;
      }

      // High motion for drops
      if (inDrop && clip.metadata?.motionEnergy && clip.metadata.motionEnergy > SYNC_SCORING.DROP_MOTION_THRESHOLD) {
        score += CLIP_SELECTION.DROP_HIGH_MOTION_BONUS;
      }

      // Smart reorder: prefer similar brightness for smoother flow
      if (enableSmartReorder && lastSegment && clip.metadata?.brightness) {
        const lastClip = clips[lastSegment.videoIndex];
        if (lastClip?.metadata?.brightness) {
          const brightnessDiff = Math.abs(clip.metadata.brightness - lastClip.metadata.brightness);
          score += (1 - brightnessDiff) * CLIP_SELECTION.BRIGHTNESS_SIMILARITY_BONUS;
        }
      }

      return { index, score };
    });

    scored.sort((a, b) => b.score - a.score);

    // CRITICAL: Filter out blocked clips (score -1000) BEFORE selecting
    const validCandidates = scored.filter(s => s.score > -500);

    // Debug: Log blocked clips
    const blockedClips = scored.filter(s => s.score <= -500);
    if (blockedClips.length > 0) {
      console.log(`🚫 Blocked clips: [${blockedClips.map(c => c.index + 1).join(', ')}] | Last used: ${lastUsedIndex + 1} | Recent: [${recentIndices.map(i => i + 1).join(', ')}]`);
    }

    // If somehow all clips are blocked (shouldn't happen), fall back to highest scored
    if (validCandidates.length === 0) {
      console.warn('⚠️ All clips blocked! Falling back to highest scored clip.');
      return { index: scored[0].index };
    }

    // Randomness among top VALID candidates to use more clips
    const topCount = Math.max(
      CLIP_SELECTION.MIN_TOP_CANDIDATES,
      Math.ceil(validCandidates.length * CLIP_SELECTION.TOP_CANDIDATES_PERCENTAGE)
    );
    const topCandidates = validCandidates.slice(0, Math.min(topCount, validCandidates.length));
    const selected = topCandidates[Math.floor(Math.random() * topCandidates.length)];

    return { index: selected.index };
  }

  private selectTransition(
    beat: BeatMarker,
    inDrop: boolean,
    atDropPeak: boolean,
    segmentIndex: number,
    preset?: StylePreset
  ): TransitionType {

    if (segmentIndex === 0) return TransitionType.CUT;

    // Drop peak = IMPACT
    if (atDropPeak) return TransitionType.IMPACT;

    // During drop = fast cuts with fx
    if (inDrop) {
      const r = Math.random();
      if (r < 0.15) return TransitionType.GLITCH;
      if (r < 0.25) return TransitionType.FLASH;
      if (r < 0.35) return TransitionType.WHIP;
      return TransitionType.CUT;
    }

    // High intensity
    if (beat.intensity > 0.8) {
      return Math.random() < 0.5 ? TransitionType.ZOOM : TransitionType.WHIP;
    }

    // Downbeat
    if (beat.isDownbeat) {
      return Math.random() < 0.3 ? TransitionType.ZOOM : TransitionType.CUT;
    }

    // Low intensity
    if (beat.intensity < 0.3) {
      return Math.random() < 0.4 ? TransitionType.CROSSFADE : TransitionType.CUT;
    }

    return TransitionType.CUT;
  }

  private selectFilter(
    beat: BeatMarker,
    inDrop: boolean,
    transition: TransitionType
  ): 'none' | 'bw' | 'contrast' | 'cyber' | 'saturate' | 'warm' {

    if (transition === TransitionType.GLITCH) return 'cyber';
    if (transition === TransitionType.IMPACT) return 'contrast';

    if (inDrop && Math.random() < 0.25) return 'saturate';
    if (beat.intensity > 0.85) return 'contrast';
    if (beat.intensity < 0.25) {
      return Math.random() < 0.3 ? 'bw' : 'warm';
    }

    return 'none';
  }

  private calculateClipStartTime(
    clip: VideoClip,
    beat: BeatMarker,
    segmentDuration: number,
    isHero: boolean
  ): number {

    const availableDuration = clip.trimEnd - clip.trimStart;

    // If segment is longer than available clip, start at beginning
    if (segmentDuration >= availableDuration) {
      return clip.trimStart;
    }

    // Hero moments use peak motion timestamp
    if (isHero && clip.metadata?.peakMotionTimestamp) {
      const peakTime = clip.metadata.peakMotionTimestamp;
      const startTime = Math.max(clip.trimStart, peakTime - segmentDuration / 2);
      const maxStart = clip.trimEnd - segmentDuration;
      return Math.max(clip.trimStart, Math.min(startTime, maxStart));
    }

    const maxStart = clip.trimEnd - segmentDuration;
    const range = maxStart - clip.trimStart;

    if (range <= 0) return clip.trimStart;

    return clip.trimStart + Math.random() * range;
  }

  private calculateSegmentScore(
    beat: BeatMarker,
    clip: VideoClip,
    inDrop: boolean,
    isHero: boolean
  ): number {
    let score = SYNC_SCORING.BASE_SCORE;

    // Motion match bonus
    if (clip.metadata?.motionEnergy !== undefined && !isNaN(clip.metadata.motionEnergy)) {
      const motionMatch = 1 - Math.abs(clip.metadata.motionEnergy - beat.intensity);
      if (!isNaN(motionMatch)) {
        score += motionMatch * SYNC_SCORING.MOTION_MATCH_MAX_BONUS;
      }
    }

    // Drop + high motion = excellent
    if (inDrop && clip.metadata?.motionEnergy !== undefined && !isNaN(clip.metadata.motionEnergy) && clip.metadata.motionEnergy > SYNC_SCORING.DROP_MOTION_THRESHOLD) {
      score += SYNC_SCORING.DROP_HIGH_MOTION_BONUS;
    }

    // Hero moment with hero clip = excellent
    if (isHero && clip.isHeroClip) {
      score += SYNC_SCORING.HERO_MOMENT_BONUS;
    }

    return Math.min(100, Math.round(score));
  }

  private countBeatsUntilEnergyRise(
    beats: BeatMarker[],
    startIndex: number,
    threshold: number
  ): number {
    let count = 1;
    for (let i = startIndex + 1; i < beats.length && count < 8; i++) {
      if (beats[i].intensity >= threshold) break;
      count++;
    }
    return count;
  }

  private getDropIndex(time: number, drops: DropZone[]): number {
    return drops.findIndex(d => time >= d.startTime && time <= d.endTime);
  }
}

export const segmentationService = new SegmentationService();
