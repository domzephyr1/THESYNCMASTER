import { BeatMarker, DropZone, PhraseData } from '../types';

declare var EssentiaWASM: any;
declare var Essentia: any;

export class AudioAnalyzerService {
  private audioContext: AudioContext;
  private essentia: any = null;

  constructor() {
    this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  }

  private async initEssentia() {
    const maxRetries = 20;
    let attempts = 0;

    return new Promise<void>((resolve) => {
      const check = async () => {
        if (typeof EssentiaWASM !== 'undefined' && typeof Essentia !== 'undefined') {
          try {
            // EssentiaWASM is a function that returns a promise
            const wasmModule = await EssentiaWASM();
            this.essentia = new Essentia(wasmModule);
            console.log("✅ Essentia.js Initialized");
            resolve();
          } catch (e) {
            console.warn("Essentia init error", e);
            resolve();
          }
        } else if (attempts < maxRetries) {
          attempts++;
          setTimeout(check, 100);
        } else {
          console.warn("Essentia timed out");
          resolve();
        }
      };
      check();
    });
  }

  async decodeAudio(file: File): Promise<AudioBuffer> {
    const arrayBuffer = await file.arrayBuffer();
    return await this.audioContext.decodeAudioData(arrayBuffer);
  }

  getWaveformData(buffer: AudioBuffer, samples: number = 200): number[] {
    const rawData = buffer.getChannelData(0);
    const blockSize = Math.floor(rawData.length / samples);
    const waveform = [];

    for (let i = 0; i < samples; i++) {
      const start = i * blockSize;
      let sum = 0;
      for (let j = 0; j < blockSize; j++) {
        sum += Math.abs(rawData[start + j]);
      }
      waveform.push(sum / blockSize);
    }

    const max = Math.max(...waveform);
    return waveform.map(val => val / max);
  }

  // ============ ENHANCED BEAT DETECTION ============

  async detectBeatsEnhanced(
    buffer: AudioBuffer,
    minEnergy: number = 0.1,
    sensitivity: number = 1.5
  ): Promise<{ beats: BeatMarker[], phraseData: PhraseData }> {

    // 1. Get raw beats
    const rawBeats = await this.detectBeats(buffer, minEnergy, sensitivity);

    // 2. Analyze energy envelope for drop detection
    const energyEnvelope = this.getEnergyEnvelope(buffer);
    const drops = this.detectDrops(energyEnvelope, buffer.duration);

    // 3. Estimate BPM and bar structure
    const bpm = this.estimateBPM(rawBeats);
    const barDuration = (60 / bpm) * 4;

    // 4. Assign phrase positions to beats
    const enhancedBeats = this.assignPhrasePositions(rawBeats, barDuration, drops);

    // 5. Identify hero moments
    const finalBeats = this.identifyHeroMoments(enhancedBeats, drops);

    const phraseData: PhraseData = {
      barDuration,
      phraseBars: 8,
      downbeats: finalBeats.filter(b => b.isDownbeat).map(b => b.time),
      drops
    };

    console.log(`🎵 Enhanced analysis: ${finalBeats.length} beats, ${drops.length} drops, ${finalBeats.filter(b => b.isHeroMoment).length} heroes`);

    return { beats: finalBeats, phraseData };
  }

  private getEnergyEnvelope(buffer: AudioBuffer, windowMs: number = 50): number[] {
    const rawData = buffer.getChannelData(0);
    const sampleRate = buffer.sampleRate;
    const windowSamples = Math.floor(sampleRate * (windowMs / 1000));
    const envelope: number[] = [];

    for (let i = 0; i < rawData.length; i += windowSamples) {
      let sum = 0;
      for (let j = 0; j < windowSamples && i + j < rawData.length; j++) {
        sum += rawData[i + j] * rawData[i + j];
      }
      envelope.push(Math.sqrt(sum / windowSamples));
    }

    const max = Math.max(...envelope);
    return envelope.map(v => v / max);
  }

  private detectDrops(envelope: number[], duration: number): DropZone[] {
    const drops: DropZone[] = [];
    const windowSize = 20;
    const dropThreshold = 0.25; // Reduced from 0.4 - more sensitive

    const timePerSample = duration / envelope.length;

    for (let i = windowSize; i < envelope.length - windowSize; i++) {
      const beforeEnergy = envelope.slice(i - windowSize, i).reduce((a, b) => a + b, 0) / windowSize;
      const dropEnergy = envelope[i];
      const afterEnergy = envelope.slice(i, i + windowSize).reduce((a, b) => a + b, 0) / windowSize;

      // More lenient detection: look for energy jumps from lower to higher
      if (beforeEnergy < 0.6 && dropEnergy > beforeEnergy + dropThreshold && afterEnergy > 0.4) {
        const peakTime = i * timePerSample;

        const lastDrop = drops[drops.length - 1];
        if (!lastDrop || peakTime - lastDrop.peakTime > 4) {
          drops.push({
            startTime: Math.max(0, peakTime - 2),
            peakTime: peakTime,
            endTime: Math.min(duration, peakTime + 4),
            intensity: dropEnergy
          });
        }
      }
    }

    console.log(`🔥 Detected ${drops.length} drops`);
    return drops;
  }

  private estimateBPM(beats: BeatMarker[]): number {
    if (beats.length < 4) return 120;

    const intervals: number[] = [];
    for (let i = 1; i < beats.length; i++) {
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

  private assignPhrasePositions(beats: BeatMarker[], barDuration: number, drops: DropZone[]): BeatMarker[] {
    const beatDuration = barDuration / 4;

    return beats.map((beat) => {
      const beatsFromStart = beat.time / beatDuration;
      const barPosition = (Math.round(beatsFromStart) % 4) + 1;

      const phraseBeats = 32;
      const phrasePosition = (Math.round(beatsFromStart) % phraseBeats) + 1;

      const isDownbeat = barPosition === 1;
      const isDrop = drops.some(d => beat.time >= d.startTime && beat.time <= d.endTime);

      return {
        ...beat,
        barPosition,
        phrasePosition,
        isDownbeat,
        isDrop
      };
    });
  }

  private identifyHeroMoments(beats: BeatMarker[], drops: DropZone[]): BeatMarker[] {
    const heroIndices = new Set<number>();

    // Add drop peaks by index
    drops.forEach(drop => {
      const closestIndex = beats.reduce((prevIdx, curr, currIdx) => {
        if (!curr || !beats[prevIdx]) return prevIdx;
        const prevDist = Math.abs(beats[prevIdx].time - drop.peakTime);
        const currDist = Math.abs(curr.time - drop.peakTime);
        return currDist < prevDist ? currIdx : prevIdx;
      }, 0);
      heroIndices.add(closestIndex);
    });

    // Add phrase boundary downbeats by index
    beats.forEach((beat, idx) => {
      if (beat && beat.isDownbeat && beat.phrasePosition === 1) {
        heroIndices.add(idx);
      }
    });

    // Add top 5% intensity beats by index
    const sortedByIntensity = beats
      .map((beat, idx) => ({ beat, idx }))
      .filter(item => item.beat && typeof item.beat.intensity === 'number')
      .sort((a, b) => b.beat.intensity - a.beat.intensity);
    const top5Percent = Math.max(3, Math.floor(beats.length * 0.05));
    sortedByIntensity.slice(0, top5Percent).forEach(item => heroIndices.add(item.idx));

    console.log(`🦸 Hero moments: ${heroIndices.size} from drops(${drops.length}), phrase boundaries, and top ${top5Percent} intensity`);

    return beats.map((beat, idx) => ({
      ...beat,
      isHeroMoment: heroIndices.has(idx)
    }));
  }

  // ============ ORIGINAL BEAT DETECTION ============

  async detectBeats(buffer: AudioBuffer, minEnergy: number = 0.1, sensitivity: number = 1.5): Promise<BeatMarker[]> {
    if (!this.essentia) {
      await this.initEssentia();
    }

    if (this.essentia) {
      try {
        const channelData = buffer.getChannelData(0);
        const vectorSignal = this.essentia.arrayToVector(channelData);
        const rhythm = this.essentia.RhythmExtractor2013(vectorSignal);
        const ticks = this.essentia.vectorToArray(rhythm.ticks);
        const bpm = rhythm.bpm;

        if (vectorSignal.delete) vectorSignal.delete();

        if (ticks.length > 0) {
          // Convert Essentia vector to proper JavaScript array
          const ticksArray: number[] = [];
          for (let i = 0; i < ticks.length; i++) {
            ticksArray.push(ticks[i]);
          }

          // Filter beats based on sensitivity - higher sensitivity = fewer beats
          // sensitivity 1.0 = keep every beat, 4.0 = keep only every 4th beat (downbeats)
          const beatInterval = Math.max(1, Math.floor(sensitivity));
          const filteredTicks = ticksArray.filter((_, idx) => idx % beatInterval === 0);

          // Also respect minEnergy by limiting total beats
          // Higher minEnergy = fewer beats (more selective)
          const maxBeats = Math.floor(buffer.duration / (0.3 + minEnergy * 2));
          const finalTicks = filteredTicks.length > maxBeats
            ? filteredTicks.filter((_, idx) => idx % Math.ceil(filteredTicks.length / maxBeats) === 0)
            : filteredTicks;

          console.log(`🎵 Essentia: ${ticksArray.length} raw → ${filteredTicks.length} filtered → ${finalTicks.length} final (sensitivity=${sensitivity}, minEnergy=${minEnergy})`);

          return finalTicks.map((time: number) => ({
            time,
            intensity: 0.8
          }));
        }
      } catch (e) {
        console.warn("Essentia analysis failed, falling back to Multi-Band", e);
      }
    }

    console.log("Using Multi-Band Frequency Analysis");
    const lowPeaks = await this.analyzeBand(buffer, 'lowpass', 250, 1.2, minEnergy, sensitivity);
    const midPeaks = await this.analyzeBand(buffer, 'bandpass', 1200, 1.0, minEnergy, sensitivity);
    const highPeaks = await this.analyzeBand(buffer, 'highpass', 4000, 0.8, minEnergy, sensitivity * 1.2);

    const allPeaks = [...lowPeaks, ...midPeaks, ...highPeaks].sort((a, b) => a.time - b.time);
    return this.mergeBeats(allPeaks, 0.15);
  }

  private async analyzeBand(
    buffer: AudioBuffer,
    type: BiquadFilterType,
    freq: number,
    weight: number,
    minEnergy: number,
    sensitivity: number
  ): Promise<BeatMarker[]> {
    const offlineCtx = new OfflineAudioContext(1, buffer.length, buffer.sampleRate);
    const source = offlineCtx.createBufferSource();
    source.buffer = buffer;

    const filter = offlineCtx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = 1.0;

    source.connect(filter);
    filter.connect(offlineCtx.destination);
    source.start();

    const renderedBuffer = await offlineCtx.startRendering();
    const peaks = this.findPeaks(renderedBuffer, minEnergy, sensitivity);

    return peaks.map(p => ({ ...p, intensity: p.intensity * weight }));
  }

  private findPeaks(buffer: AudioBuffer, minEnergy: number, sensitivity: number): BeatMarker[] {
    const rawData = buffer.getChannelData(0);
    const sampleRate = buffer.sampleRate;
    const beats: BeatMarker[] = [];

    const windowSize = 0.05;
    const samplesPerWindow = Math.floor(sampleRate * windowSize);

    const historySize = Math.floor(1.0 / windowSize);
    const energyHistory: number[] = new Array(historySize).fill(0);

    const minBeatInterval = 0.12; // Reduced for faster cuts
    let lastBeatTime = -minBeatInterval;

    for (let i = 0; i < rawData.length; i += samplesPerWindow) {
      let sum = 0;
      for (let j = 0; j < samplesPerWindow && i + j < rawData.length; j++) {
        const sample = rawData[i + j];
        sum += sample * sample;
      }
      const instantEnergy = Math.sqrt(sum / samplesPerWindow);

      const localAverage = energyHistory.reduce((a, b) => a + b, 0) / energyHistory.length;

      energyHistory.push(instantEnergy);
      energyHistory.shift();

      const currentTime = i / sampleRate;

      if (instantEnergy > minEnergy && instantEnergy > (localAverage * sensitivity)) {
        if (currentTime - lastBeatTime > minBeatInterval) {
          beats.push({
            time: currentTime,
            intensity: instantEnergy
          });
          lastBeatTime = currentTime;
        }
      }
    }

    return beats;
  }

  private mergeBeats(beats: BeatMarker[], window: number): BeatMarker[] {
    if (beats.length === 0) return [];

    const merged: BeatMarker[] = [];
    let currentGroup: BeatMarker[] = [beats[0]];

    for (let i = 1; i < beats.length; i++) {
      const beat = beats[i];
      const prevGroupBeat = currentGroup[0];

      if (beat.time - prevGroupBeat.time < window) {
        currentGroup.push(beat);
      } else {
        const best = currentGroup.reduce((p, c) => (p.intensity > c.intensity ? p : c));
        merged.push(best);
        currentGroup = [beat];
      }
    }

    if (currentGroup.length > 0) {
      const best = currentGroup.reduce((p, c) => (p.intensity > c.intensity ? p : c));
      merged.push(best);
    }

    return merged;
  }
}

export const audioService = new AudioAnalyzerService();
