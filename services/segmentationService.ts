import { BeatMarker, EnhancedSyncSegment, TransitionType, VideoClip, DropZone, PhraseData, MontageOptions, MontageResult, StylePreset } from '../types';

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
      const minDuration = inDrop ? 0.12 : 0.2;
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
        if (inDrop && beat.intensity > 0.8) {
          playbackSpeed = 1.2; // Speed up on high energy
        } else if (beat.intensity < 0.3 && !inDrop) {
          playbackSpeed = 0.7; // Slow-mo on quiet parts
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

    console.log(`🎬 Generated ${segments.length} segments | ${heroBeats.length} hero moments | ${drops.length} drops | Score: ${averageScore}%`);

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
    if (beats.length < 4) return 120;

    const intervals: number[] = [];
    for (let i = 1; i < Math.min(beats.length, 50); i++) {
      intervals.push(beats[i].time - beats[i - 1].time);
    }

    intervals.sort((a, b) => a - b);
    const median = intervals[Math.floor(intervals.length / 2)];
    const filtered = intervals.filter(i => Math.abs(i - median) < median * 0.3);
    const avgInterval = filtered.reduce((a, b) => a + b, 0) / filtered.length;

    let bpm = 60 / avgInterval;
    while (bpm < 80) bpm *= 2;
    while (bpm > 180) bpm /= 2;

    return Math.round(bpm);
  }

  private inferDrops(beats: BeatMarker[]): DropZone[] {
    const drops: DropZone[] = [];
    const windowSize = 8;

    for (let i = windowSize; i < beats.length - windowSize; i++) {
      const beforeAvg = beats.slice(i - windowSize, i)
        .reduce((sum, b) => sum + b.intensity, 0) / windowSize;
      const afterAvg = beats.slice(i, i + windowSize)
        .reduce((sum, b) => sum + b.intensity, 0) / windowSize;

      // More lenient: detect energy jumps
      if (beforeAvg < 0.5 && afterAvg > 0.5 && beats[i].intensity > 0.6) {
        const lastDrop = drops[drops.length - 1];
        if (!lastDrop || beats[i].time - lastDrop.peakTime > 8) {
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

    const scored = clips.map((clip, index) => {
      let score = 100;

      // Penalize recent use
      const lastTime = lastUsedTime.get(index) || -Infinity;
      const timeSinceUse = beat.time - lastTime;
      if (timeSinceUse < 5) score -= (5 - timeSinceUse) * 10;

      // Penalize same as previous
      if (index === lastUsedIndex) score -= 50;

      // Penalize overuse
      const uses = usageCount.get(index) || 0;
      score -= uses * 5;

      // Motion matching
      if (clip.metadata?.motionEnergy) {
        const motionMatch = 1 - Math.abs(clip.metadata.motionEnergy - beat.intensity);
        score += motionMatch * 25;
      }

      // Hero clip bonus
      if (isHero && heroClipIndices.includes(index)) {
        score += 35;
      }

      // High motion for drops
      if (inDrop && clip.metadata?.motionEnergy && clip.metadata.motionEnergy > 0.6) {
        score += 30;
      }

      // Smart reorder: prefer similar brightness for smoother flow
      if (enableSmartReorder && lastSegment && clip.metadata?.brightness) {
        const lastClip = clips[lastSegment.videoIndex];
        if (lastClip?.metadata?.brightness) {
          const brightnessDiff = Math.abs(clip.metadata.brightness - lastClip.metadata.brightness);
          score += (1 - brightnessDiff) * 15;
        }
      }

      return { index, score };
    });

    scored.sort((a, b) => b.score - a.score);

    // Randomness among top 50% of candidates to use more clips
    const topCandidates = scored.slice(0, Math.max(3, Math.ceil(clips.length * 0.5)));
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
    let score = 50; // Base score

    // Motion match bonus
    if (clip.metadata?.motionEnergy !== undefined && !isNaN(clip.metadata.motionEnergy)) {
      const motionMatch = 1 - Math.abs(clip.metadata.motionEnergy - beat.intensity);
      if (!isNaN(motionMatch)) {
        score += motionMatch * 30;
      }
    }

    // Drop + high motion = excellent
    if (inDrop && clip.metadata?.motionEnergy !== undefined && !isNaN(clip.metadata.motionEnergy) && clip.metadata.motionEnergy > 0.6) {
      score += 15;
    }

    // Hero moment with hero clip = excellent
    if (isHero && clip.isHeroClip) {
      score += 20;
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
