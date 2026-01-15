import { BeatMarker, EnhancedSyncSegment, TransitionType, VideoClip } from '../types';

export class SegmentationService {
  
  generateMontage(
    beats: BeatMarker[], 
    videoClips: VideoClip[], 
    duration: number
  ): { segments: EnhancedSyncSegment[], bpm: number } {
    
    if (!beats.length || !videoClips.length || duration === 0) {
      return { segments: [], bpm: 0 };
    }

    // --- BPM Calculation ---
    let estimatedBpm = 0;
    let minSegmentDuration = 0.5; // Default

    if (beats.length > 1) {
       const avgInterval = (beats[beats.length - 1].time - beats[0].time) / beats.length;
       const bpm = 60 / avgInterval;
       estimatedBpm = Math.round(bpm);

       if (bpm > 135) minSegmentDuration = 0.25; 
       else if (bpm < 90) minSegmentDuration = 1.0; 
       else minSegmentDuration = 0.5; 
    }

    const newSegments: EnhancedSyncSegment[] = [];
    let startTime = 0;
    
    // Filter beats for segments based on min duration
    const validCutTimes: number[] = [];
    const beatIndices: number[] = [];
    let lastCutTime = 0;

    for (let i = 0; i < beats.length; i++) {
        const b = beats[i];
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
    
    // --- ADVANCED SELECTION & TRANSITION LOGIC ---
    const MIN_REP_INTERVAL = 15; 
    let unusedIndices = Array.from({ length: videoClips.length }, (_, i) => i);
    const usageHistory: Record<number, number> = {}; 
    let lastVideoIndex = -1;

    for (let k = 0; k < validCutTimes.length; k++) {
      const endTime = validCutTimes[k];
      if (endTime <= startTime) continue;
      
      const currentBeatIdx = beatIndices[k];
      const currentBeat = beats[currentBeatIdx] || { intensity: 0.5 };
      const prevBeat = beats[beatIndices[k-1]] || { intensity: 0.5 };
      
      // -- 1. DETERMINE TRANSITION --
      const segmentDuration = endTime - startTime;
      const energyDelta = Math.abs(currentBeat.intensity - prevBeat.intensity);
      
      let transition = TransitionType.CUT;
      if (segmentDuration < 0.4) {
          transition = TransitionType.CUT; // Fast cuts
      } else if (energyDelta > 0.4) {
          transition = TransitionType.GLITCH; // Big energy shift
      } else if (currentBeat.intensity > 0.8) {
          transition = TransitionType.ZOOM; // High energy impact
      } else if (currentBeat.intensity < 0.3 && segmentDuration > 2.0) {
          transition = TransitionType.CROSSFADE; // Slow flow
      }

      // -- 2. CONTEXT-AWARE CLIP SELECTION --
      const allIndices = Array.from({ length: videoClips.length }, (_, i) => i);
      
      // Filter by Metadata (Energy Match)
      let energyCandidates = allIndices;
      if (videoClips.some(c => c.metadata?.processed)) {
         energyCandidates = allIndices.filter(i => {
             const meta = videoClips[i].metadata;
             if (!meta || !meta.processed) return true;
             // High Intensity -> High Brightness or High Contrast
             if (currentBeat.intensity > 0.7) return meta.brightness > 0.5 || meta.contrast > 0.5;
             // Low Intensity -> Darker
             if (currentBeat.intensity < 0.4) return meta.brightness <= 0.5;
             return true;
         });
         // Fallback if filtering removed all options
         if (energyCandidates.length === 0) energyCandidates = allIndices;
      }

      // -- 3. ANTI-REPETITION LOGIC --
      const isUnused = (i: number) => unusedIndices.includes(i);
      const isTimeReady = (i: number) => {
          const lastEnd = usageHistory[i] || -Infinity;
          return startTime - lastEnd >= MIN_REP_INTERVAL;
      };
      const isNotPrevious = (i: number) => i !== lastVideoIndex;

      let finalCandidates: number[] = [];

      // Priority 1: Unused & Matches Energy & Not Previous
      finalCandidates = energyCandidates.filter(i => isUnused(i) && isNotPrevious(i));

      // Priority 2: Unused (Any energy)
      if (finalCandidates.length === 0) {
        finalCandidates = allIndices.filter(i => isUnused(i) && isNotPrevious(i));
      }
      
      // Priority 3: Used & Ready & Matches Energy
      if (finalCandidates.length === 0) {
        energyCandidates.filter(i => isTimeReady(i) && isNotPrevious(i));
      }

      // Priority 4: Used & Not Previous (Any)
      if (finalCandidates.length === 0) {
        finalCandidates = allIndices.filter(i => isNotPrevious(i));
      }

      // Priority 5: Desperation
      if (finalCandidates.length === 0) finalCandidates = allIndices;

      const videoIndex = finalCandidates[Math.floor(Math.random() * finalCandidates.length)];
      
      // Update History
      if (isUnused(videoIndex)) {
         unusedIndices = unusedIndices.filter(i => i !== videoIndex);
      }
      usageHistory[videoIndex] = endTime;
      
      // -- 4. TRIM LOGIC --
      const clip = videoClips[videoIndex];
      let clipStartTime = clip.trimStart;
      const validClipDuration = clip.trimEnd - clip.trimStart;
      
      if (validClipDuration > segmentDuration) {
        const maxStart = clip.trimEnd - segmentDuration;
        clipStartTime = clip.trimStart + (Math.random() * (maxStart - clip.trimStart));
      } else {
        // Loop protection: if segment is longer than clip, we start at beginning 
        // Logic handled in Player for looping, here we just set start
        clipStartTime = clip.trimStart;
      }

      // -- 5. FX --
      let filter: 'none' | 'bw' | 'contrast' | 'cyber' = 'none';
      if (transition === TransitionType.GLITCH) filter = 'cyber';
      else if (currentBeat.intensity > 0.9) filter = 'contrast';

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

    return { segments: newSegments, bpm: estimatedBpm };
  }
}

export const segmentationService = new SegmentationService();