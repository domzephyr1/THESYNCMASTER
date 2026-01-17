import { BeatMarker, EnhancedSyncSegment, TransitionType, VideoClip, StylePreset } from '../types';

// Pre-roll: cut slightly BEFORE beat for perceived sync (humans anticipate)
const PRE_ROLL_SECONDS = 0.03; // 30ms

export interface MontageOptions {
  enableSpeedRamping?: boolean;
  enableSmartReorder?: boolean;
  preset?: StylePreset;
}

export class SegmentationService {

  // Calculate how well a clip matches a beat (0-100 score)
  private scoreClipForBeat(clip: VideoClip, beat: BeatMarker): number {
    let score = 50; // Base score
    const meta = clip.metadata;

    if (!meta?.processed) {
      // No metadata - return neutral score with small random variance
      return 50 + Math.random() * 10;
    }

    // High intensity beats prefer high motion/contrast clips
    if (beat.intensity > 0.7) {
      if (meta.motion > 0.5) score += 20;
      if (meta.contrast > 0.5) score += 15;
      if (meta.visualInterest > 0.6) score += 15;
    }
    // Medium intensity beats - balanced preference
    else if (beat.intensity > 0.4) {
      if (meta.motion > 0.3 && meta.motion < 0.7) score += 15;
      if (meta.visualInterest > 0.4) score += 10;
    }
    // Low intensity beats prefer calmer clips
    else {
      if (meta.motion < 0.4) score += 15;
      if (meta.brightness > 0.3 && meta.brightness < 0.7) score += 10;
      if (meta.contrast < 0.5) score += 5;
    }

    // Visual interest always adds value
    if (meta.visualInterest) {
      score += meta.visualInterest * 10;
    }

    return Math.min(100, Math.max(0, score));
  }

  // Calculate speed multiplier based on beat energy
  private calculateSpeedMultiplier(beatIntensity: number, segmentDuration: number): number {
    // Low energy (0-0.3) -> slow mo (0.5-0.7x)
    // Medium energy (0.3-0.7) -> normal (1.0x)
    // High energy (0.7-1.0) -> speed up (1.2-1.5x)

    if (beatIntensity < 0.3) {
      // Slow mo for quiet/buildup sections
      // Only apply to segments long enough to notice
      if (segmentDuration > 1.5) {
        return 0.5 + (beatIntensity * 0.67); // 0.5 to 0.7
      }
      return 1.0;
    } else if (beatIntensity > 0.7) {
      // Speed up for high energy drops
      return 1.0 + ((beatIntensity - 0.7) * 1.67); // 1.0 to 1.5
    }

    return 1.0; // Normal speed for medium energy
  }

  // Calculate visual similarity between two clips (0-1)
  private clipSimilarity(clipA: VideoClip, clipB: VideoClip): number {
    const metaA = clipA.metadata;
    const metaB = clipB.metadata;

    // If either clip lacks metadata, return neutral similarity
    if (!metaA?.processed || !metaB?.processed) {
      return 0.5;
    }

    // Calculate similarity based on visual properties
    const brightnessDiff = Math.abs(metaA.brightness - metaB.brightness);
    const contrastDiff = Math.abs(metaA.contrast - metaB.contrast);
    const motionDiff = Math.abs(metaA.motion - metaB.motion);

    // Convert differences to similarity (1 = identical, 0 = completely different)
    const brightnessSim = 1 - brightnessDiff;
    const contrastSim = 1 - contrastDiff;
    const motionSim = 1 - motionDiff;

    // Weighted average - motion is most noticeable to viewers
    return (brightnessSim * 0.25) + (contrastSim * 0.25) + (motionSim * 0.5);
  }

  generateMontage(
    beats: BeatMarker[],
    videoClips: VideoClip[],
    duration: number,
    options: MontageOptions = {}
  ): { segments: EnhancedSyncSegment[], bpm: number, averageScore: number } {
    const { enableSpeedRamping = false, enableSmartReorder = false, preset } = options;

    console.log(`🎬 generateMontage: ${beats.length} beats, ${videoClips.length} clips, ${duration.toFixed(1)}s`);

    if (!beats.length || !videoClips.length || duration === 0) {
      console.warn('⚠️ generateMontage returning empty - missing data');
      return { segments: [], bpm: 0, averageScore: 0 };
    }

    // Filter to only clips with valid duration (trimEnd > trimStart)
    const validClipIndices: number[] = [];
    videoClips.forEach((clip, index) => {
      const validDuration = clip.trimEnd - clip.trimStart;
      if (validDuration > 0.1) { // At least 0.1s of usable content
        validClipIndices.push(index);
      }
    });

    if (validClipIndices.length < videoClips.length) {
      console.warn(`⚠️ ${videoClips.length - validClipIndices.length} clips have invalid duration`);
    }

    if (validClipIndices.length === 0) {
      console.error('❌ No valid clips available! All clips have trimEnd <= trimStart');
      return { segments: [], bpm: 0, averageScore: 0 };
    }

    // --- BPM Calculation ---
    let estimatedBpm = 0;
    let minSegmentDuration = 1.5; // Default (increased for better performance)

    if (beats.length > 1) {
       const avgInterval = (beats[beats.length - 1].time - beats[0].time) / beats.length;
       const bpm = 60 / avgInterval;
       estimatedBpm = Math.round(bpm);

       // Dynamic min segment based on tempo - increased durations for stability
       if (bpm > 150) minSegmentDuration = 0.5;       // Very fast: 0.5s cuts
       else if (bpm > 120) minSegmentDuration = 0.75; // Fast: 0.75s cuts
       else if (bpm > 100) minSegmentDuration = 1.0;  // Medium: 1s cuts
       else if (bpm > 80) minSegmentDuration = 1.5;   // Slow-medium: 1.5s cuts
       else minSegmentDuration = 2.0;                 // Slow: 2s cuts
    }

    // Cap maximum segments to prevent performance issues
    const MAX_SEGMENTS = 100;
    const estimatedSegments = Math.ceil(duration / minSegmentDuration);
    if (estimatedSegments > MAX_SEGMENTS) {
      minSegmentDuration = duration / MAX_SEGMENTS;
    }

    const newSegments: EnhancedSyncSegment[] = [];
    let startTime = 0;

    // Apply pre-roll offset to beat times for tighter perceived sync
    const adjustedBeats = beats.map(b => ({
      ...b,
      time: Math.max(0, b.time - PRE_ROLL_SECONDS)
    }));

    // Filter beats for segments based on min duration
    const validCutTimes: number[] = [];
    const beatIndices: number[] = [];
    let lastCutTime = 0;

    for (let i = 0; i < adjustedBeats.length; i++) {
        const b = adjustedBeats[i];
        if (b.time - lastCutTime >= minSegmentDuration) {
            validCutTimes.push(b.time);
            beatIndices.push(i);
            lastCutTime = b.time;
        }
    }

    // Ensure we finish at the end
    if (validCutTimes.length === 0 || validCutTimes[validCutTimes.length - 1] < duration - 0.1) {
       validCutTimes.push(duration);
       beatIndices.push(beats.length - 1);
    }

    // --- SMART CLIP SELECTION WITH VARIETY ---
    const clipUsageCount: Record<number, number> = {};
    const recentClips: number[] = []; // Track last N clips used
    const RECENCY_WINDOW = 3; // Don't repeat within last 3 clips
    let lastVideoIndex = -1;

    for (let k = 0; k < validCutTimes.length; k++) {
      const endTime = validCutTimes[k];
      if (endTime <= startTime) continue;

      const currentBeatIdx = beatIndices[k];
      const currentBeat = beats[currentBeatIdx] || { intensity: 0.5 };
      const prevBeat = beats[beatIndices[k-1]] || { intensity: 0.5 };

      // -- 1. DETERMINE TRANSITION based on energy --
      const segmentDuration = endTime - startTime;
      const energyDelta = Math.abs(currentBeat.intensity - prevBeat.intensity);

      let transition = TransitionType.CUT;
      if (segmentDuration < 0.4) {
          transition = TransitionType.CUT; // Fast cuts stay cuts
      } else if (energyDelta > 0.4) {
          transition = TransitionType.GLITCH; // Big energy shift = glitch
      } else if (currentBeat.intensity > 0.8) {
          transition = TransitionType.ZOOM; // High energy = zoom impact
      } else if (currentBeat.intensity < 0.3 && segmentDuration > 2.0) {
          transition = TransitionType.CROSSFADE; // Low energy, long = smooth
      }

      // -- 2. SMART CLIP SELECTION with scoring --
      // Only consider clips with valid duration
      const allIndices = validClipIndices;

      if (allIndices.length === 0) {
        console.error('❌ No valid clips to select from!');
        continue;
      }

      // Score each clip
      const clipScores = allIndices.map(i => {
        let score = 100; // Base score
        const clip = videoClips[i];
        const meta = clip.metadata;

        // Penalize recently used clips heavily
        if (recentClips.includes(i)) {
          const recencyIndex = recentClips.indexOf(i);
          score -= (RECENCY_WINDOW - recencyIndex) * 30; // More recent = bigger penalty
        }

        // Penalize overused clips
        const useCount = clipUsageCount[i] || 0;
        const avgUse = Object.values(clipUsageCount).reduce((a, b) => a + b, 0) / videoClips.length || 0;
        if (useCount > avgUse) {
          score -= (useCount - avgUse) * 10;
        }

        // Bonus for matching energy (if metadata available)
        if (meta?.processed) {
          // High beat intensity -> prefer high motion/contrast clips
          if (currentBeat.intensity > 0.7) {
            if (meta.motion > 0.5) score += 15;
            if (meta.contrast > 0.5) score += 10;
            if (meta.visualInterest > 0.6) score += 20;
          }
          // Low beat intensity -> prefer calmer clips
          if (currentBeat.intensity < 0.4) {
            if (meta.motion < 0.4) score += 10;
            if (meta.brightness > 0.3 && meta.brightness < 0.7) score += 5;
          }
        }

        // Bonus for visual interest
        if (meta?.visualInterest) {
          score += meta.visualInterest * 15;
        }

        // Smart Reorder: prefer clips with moderate similarity to previous
        // (not too similar = boring, not too different = jarring)
        if (enableSmartReorder && lastVideoIndex >= 0 && lastVideoIndex < videoClips.length) {
          const prevClip = videoClips[lastVideoIndex];
          const similarity = this.clipSimilarity(clip, prevClip);

          // Sweet spot: 0.3-0.7 similarity gets bonus
          // Too similar (>0.8) or too different (<0.2) gets penalty
          if (similarity >= 0.3 && similarity <= 0.7) {
            score += 25; // Goldilocks zone bonus
          } else if (similarity > 0.85) {
            score -= 15; // Too similar - boring
          } else if (similarity < 0.15) {
            score -= 10; // Too different - jarring
          }

          // On high energy beats, allow more variety
          if (currentBeat.intensity > 0.8) {
            score += 10; // Override similarity preference for impact
          }
        }

        // Never pick exact same as previous (unless only 1 valid clip)
        if (i === lastVideoIndex && allIndices.length > 1) {
          score -= 200;
        }

        return { index: i, score };
      });

      // Sort by score and pick from top candidates with some randomness
      clipScores.sort((a, b) => b.score - a.score);

      // Pick from top 3 candidates randomly (weighted toward better scores)
      const topN = Math.min(3, clipScores.length);
      const weights = clipScores.slice(0, topN).map((c, idx) => Math.max(1, c.score) * (topN - idx));
      const totalWeight = weights.reduce((a, b) => a + b, 0);
      let random = Math.random() * totalWeight;

      let videoIndex = clipScores[0].index;
      for (let i = 0; i < topN; i++) {
        random -= weights[i];
        if (random <= 0) {
          videoIndex = clipScores[i].index;
          break;
        }
      }

      // Update usage tracking
      clipUsageCount[videoIndex] = (clipUsageCount[videoIndex] || 0) + 1;
      recentClips.push(videoIndex);
      if (recentClips.length > RECENCY_WINDOW) {
        recentClips.shift();
      }

      // -- 3. SMART TRIM LOGIC --
      const clip = videoClips[videoIndex];
      let clipStartTime = clip.trimStart;
      const validClipDuration = clip.trimEnd - clip.trimStart;

      if (validClipDuration > segmentDuration) {
        // Pick a random but interesting start point
        const maxStart = clip.trimEnd - segmentDuration;
        // Slight bias toward middle of clip (often more interesting)
        const bias = 0.3; // 30% bias toward center
        const center = (clip.trimStart + maxStart) / 2;
        const randomOffset = (Math.random() - 0.5) * (maxStart - clip.trimStart);
        clipStartTime = center + randomOffset * (1 - bias);
        clipStartTime = Math.max(clip.trimStart, Math.min(maxStart, clipStartTime));
      } else {
        clipStartTime = clip.trimStart;
      }

      // -- 4. DYNAMIC FX based on energy --
      let filter: 'none' | 'bw' | 'contrast' | 'cyber' = 'none';
      if (transition === TransitionType.GLITCH) {
        filter = 'cyber';
      } else if (currentBeat.intensity > 0.9) {
        filter = 'contrast';
      } else if (currentBeat.intensity < 0.2 && segmentDuration > 1.5) {
        // Occasional B&W for slow, quiet moments
        filter = Math.random() > 0.7 ? 'bw' : 'none';
      }

      // Calculate clip score for this beat-clip pairing
      const clipScore = this.scoreClipForBeat(clip, currentBeat);

      // Calculate speed multiplier if enabled
      const speedMultiplier = enableSpeedRamping
        ? this.calculateSpeedMultiplier(currentBeat.intensity, segmentDuration)
        : 1.0;

      newSegments.push({
        startTime,
        endTime,
        duration: segmentDuration,
        videoIndex,
        clipStartTime,
        filter,
        transition,
        prevVideoIndex: lastVideoIndex,
        clipScore,
        speedMultiplier
      });

      lastVideoIndex = videoIndex;
      startTime = endTime;
    }

    // Calculate average clip score
    const totalScore = newSegments.reduce((sum, seg) => sum + (seg.clipScore || 50), 0);
    const averageScore = newSegments.length > 0 ? Math.round(totalScore / newSegments.length) : 0;

    // Log final summary
    const uniqueClips = new Set(newSegments.map(s => s.videoIndex)).size;
    console.log(`✅ Montage: ${newSegments.length} segments, ${uniqueClips} clips used, ${estimatedBpm} BPM, Sync Score: ${averageScore}%`);

    return { segments: newSegments, bpm: estimatedBpm, averageScore };
  }
}

export const segmentationService = new SegmentationService();