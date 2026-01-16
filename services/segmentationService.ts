import { BeatMarker, EnhancedSyncSegment, TransitionType, VideoClip } from '../types';

// Pre-roll: cut slightly BEFORE beat for perceived sync (humans anticipate)
const PRE_ROLL_SECONDS = 0.03; // 30ms

export class SegmentationService {

  generateMontage(
    beats: BeatMarker[],
    videoClips: VideoClip[],
    duration: number
  ): { segments: EnhancedSyncSegment[], bpm: number } {

    console.log('🎬 generateMontage called with:', {
      beatsCount: beats.length,
      clipsCount: videoClips.length,
      duration,
      clips: videoClips.map((c, i) => ({
        index: i,
        name: c.name,
        trimStart: c.trimStart,
        trimEnd: c.trimEnd,
        validDuration: c.trimEnd - c.trimStart
      }))
    });

    if (!beats.length || !videoClips.length || duration === 0) {
      console.warn('⚠️ generateMontage returning empty - missing data');
      return { segments: [], bpm: 0 };
    }

    // Filter to only clips with valid duration (trimEnd > trimStart)
    const validClipIndices: number[] = [];
    videoClips.forEach((clip, index) => {
      const validDuration = clip.trimEnd - clip.trimStart;
      if (validDuration > 0.1) { // At least 0.1s of usable content
        validClipIndices.push(index);
      } else {
        console.warn(`⚠️ Clip ${index} (${clip.name}) has invalid duration: ${validDuration}s`);
      }
    });

    console.log('✅ Valid clips:', validClipIndices.length, 'of', videoClips.length);

    if (validClipIndices.length === 0) {
      console.error('❌ No valid clips available! All clips have trimEnd <= trimStart');
      return { segments: [], bpm: 0 };
    }

    // --- BPM Calculation ---
    let estimatedBpm = 0;
    let minSegmentDuration = 0.5; // Default

    if (beats.length > 1) {
       const avgInterval = (beats[beats.length - 1].time - beats[0].time) / beats.length;
       const bpm = 60 / avgInterval;
       estimatedBpm = Math.round(bpm);

       // Dynamic min segment based on tempo
       if (bpm > 135) minSegmentDuration = 0.25;
       else if (bpm < 90) minSegmentDuration = 1.0;
       else minSegmentDuration = 0.5;
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

        // Never pick exact same as previous (unless only 1 valid clip)
        if (i === lastVideoIndex && allIndices.length > 1) {
          score -= 200;
        }

        return { index: i, score };
      });

      // Sort by score and pick from top candidates with some randomness
      clipScores.sort((a, b) => b.score - a.score);

      // Log scores for debugging
      if (k < 5) { // Only log first 5 segments to avoid spam
        console.log(`📊 Segment ${k} clip scores:`, clipScores.map(c => `clip${c.index}=${c.score}`).join(', '));
      }

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

      if (k < 5) {
        console.log(`🎯 Segment ${k}: Selected clip ${videoIndex} (${videoClips[videoIndex]?.name})`);
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

      newSegments.push({
        startTime,
        endTime,
        duration: segmentDuration,
        videoIndex,
        clipStartTime,
        filter,
        transition,
        prevVideoIndex: lastVideoIndex
      });

      lastVideoIndex = videoIndex;
      startTime = endTime;
    }

    // Log final summary
    const usedClipCounts: Record<number, number> = {};
    newSegments.forEach(s => {
      usedClipCounts[s.videoIndex] = (usedClipCounts[s.videoIndex] || 0) + 1;
    });
    console.log('🎬 Montage generation complete:', {
      totalSegments: newSegments.length,
      uniqueClipsUsed: Object.keys(usedClipCounts).length,
      clipUsage: usedClipCounts,
      bpm: estimatedBpm
    });

    return { segments: newSegments, bpm: estimatedBpm };
  }
}

export const segmentationService = new SegmentationService();