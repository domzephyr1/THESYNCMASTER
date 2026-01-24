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

  // ============ STELLAR SYNC ENHANCEMENTS ============

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

    // 1. RHYTHM ISOLATOR: Focuses on the "thump"
    const filter = offlineCtx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = 1.2; // Sharper resonance for transient detection

    // 2. VOCAL NOTCH: Prevents syncing to the singer (Breaks the 77% barrier)
    const vocalNotch = offlineCtx.createBiquadFilter();
    vocalNotch.type = 'notch';
    vocalNotch.frequency.value = 1000; 
    vocalNotch.Q.value = 0.5;

    source.connect(vocalNotch);
    vocalNotch.connect(filter);
    filter.connect(offlineCtx.destination);
    source.start();

    const renderedBuffer = await offlineCtx.startRendering();
    const peaks = this.findPeaks(renderedBuffer, minEnergy, sensitivity);

    return peaks.map(p => ({ ...p, intensity: p.intensity * weight }));
  }

  // ============ CORE SYNC ENGINE ============

  async detectBeatsEnhanced(
    buffer: AudioBuffer,
    minEnergy: number = 0.1,
    sensitivity: number = 1.5
  ): Promise<{ beats: BeatMarker[], phraseData: PhraseData }> {
    const rawBeats = await this.detectBeats(buffer, minEnergy, sensitivity);
    const energyEnvelope = this.getEnergyEnvelope(buffer);
    const drops = this.detectDrops(energyEnvelope, buffer.duration);
    const bpm = this.estimateBPM(rawBeats);
    const barDuration = (60 / bpm) * 4;
    const enhancedBeats = this.assignPhrasePositions(rawBeats, barDuration, drops);
    const finalBeats = this.identifyHeroMoments(enhancedBeats, drops);

    const phraseData: PhraseData = {
      barDuration,
      phraseBars: 8,
      downbeats: finalBeats.filter(b => b.isDownbeat).map(b => b.time),
      drops
    };

    return { beats: finalBeats, phraseData };
  }

  async detectBeats(buffer: AudioBuffer, minEnergy: number = 0.1, sensitivity: number = 1.5): Promise<BeatMarker[]> {
    if (!this.essentia) await this.initEssentia();

    console.log("Using Precision Multi-Band Analysis with Vocal Rejection");
    const lowPeaks = await this.analyzeBand(buffer, 'lowpass', 250, 1.2, minEnergy, sensitivity);
    const midPeaks = await this.analyzeBand(buffer, 'bandpass', 1200, 1.0, minEnergy, sensitivity);
    const highPeaks = await this.analyzeBand(buffer, 'highpass', 4000, 0.8, minEnergy, sensitivity * 1.2);

    const allPeaks = [...lowPeaks, ...midPeaks, ...highPeaks].sort((a, b) => a.time - b.time);
    return this.mergeBeats(allPeaks, 0.15);
  }

  private findPeaks(buffer: AudioBuffer, minEnergy: number, sensitivity: number): BeatMarker[] {
    const rawData = buffer.getChannelData(0);
    const sampleRate = buffer.sampleRate;
    const beats: BeatMarker[] = [];
    const windowSize = 0.05;
    const samplesPerWindow = Math.floor(sampleRate * windowSize);
    const energyHistory: number[] = new Array(Math.floor(1.0 / windowSize)).fill(0);
    let lastBeatTime = -0.15;

    for (let i = 0; i < rawData.length; i += samplesPerWindow) {
      let sum = 0;
      for (let j = 0; j < samplesPerWindow && i + j < rawData.length; j++) {
        sum += rawData[i + j] * rawData[i + j];
      }
      const instantEnergy = Math.sqrt(sum / samplesPerWindow);
      const localAverage = energyHistory.reduce((a, b) => a + b, 0) / energyHistory.length;
      energyHistory.push(instantEnergy);
      energyHistory.shift();

      const currentTime = i / sampleRate;
      if (instantEnergy > minEnergy && instantEnergy > (localAverage * sensitivity)) {
        if (currentTime - lastBeatTime > 0.15) {
          beats.push({ time: currentTime, intensity: instantEnergy });
          lastBeatTime = currentTime;
        }
      }
    }
    return beats;
  }

  // Merge nearby beats from multi-band analysis
  private mergeBeats(beats: BeatMarker[], threshold: number): BeatMarker[] {
    if (beats.length === 0) return [];

    const merged: BeatMarker[] = [];
    let group: BeatMarker[] = [beats[0]];

    for (let i = 1; i < beats.length; i++) {
      if (beats[i].time - group[group.length - 1].time < threshold) {
        group.push(beats[i]);
      } else {
        const avgTime = group.reduce((s, b) => s + b.time, 0) / group.length;
        const maxIntensity = Math.max(...group.map(b => b.intensity));
        merged.push({ time: avgTime, intensity: Math.min(1, maxIntensity) });
        group = [beats[i]];
      }
    }
    if (group.length > 0) {
      const avgTime = group.reduce((s, b) => s + b.time, 0) / group.length;
      const maxIntensity = Math.max(...group.map(b => b.intensity));
      merged.push({ time: avgTime, intensity: Math.min(1, maxIntensity) });
    }

    return merged;
  }

  // Generate waveform data for timeline visualization
  getWaveformData(buffer: AudioBuffer, numSamples: number): number[] {
    const rawData = buffer.getChannelData(0);
    const blockSize = Math.floor(rawData.length / numSamples);
    const waveform: number[] = [];

    for (let i = 0; i < numSamples; i++) {
      let sum = 0;
      for (let j = 0; j < blockSize; j++) {
        sum += Math.abs(rawData[i * blockSize + j] || 0);
      }
      waveform.push(sum / blockSize);
    }

    const max = Math.max(...waveform) || 1;
    return waveform.map(v => v / max);
  }

  // Get energy envelope for drop detection
  private getEnergyEnvelope(buffer: AudioBuffer): number[] {
    const rawData = buffer.getChannelData(0);
    const sampleRate = buffer.sampleRate;
    const windowSize = Math.floor(sampleRate * 0.1);
    const envelope: number[] = [];

    for (let i = 0; i < rawData.length; i += windowSize) {
      let sum = 0;
      for (let j = 0; j < windowSize && i + j < rawData.length; j++) {
        sum += rawData[i + j] * rawData[i + j];
      }
      envelope.push(Math.sqrt(sum / windowSize));
    }

    return envelope;
  }

  // Detect energy drops (buildups -> drops)
  private detectDrops(envelope: number[], duration: number): DropZone[] {
    const drops: DropZone[] = [];
    const windowSize = 10;
    const timePerSample = duration / envelope.length;

    for (let i = windowSize; i < envelope.length - windowSize; i++) {
      const before = envelope.slice(i - windowSize, i).reduce((a, b) => a + b, 0) / windowSize;
      const after = envelope.slice(i, i + windowSize).reduce((a, b) => a + b, 0) / windowSize;

      if (before < 0.3 && after > 0.5 && envelope[i] > 0.4) {
        const lastDrop = drops[drops.length - 1];
        const peakTime = i * timePerSample;

        if (!lastDrop || peakTime - lastDrop.peakTime > 8) {
          drops.push({
            startTime: Math.max(0, (i - 4) * timePerSample),
            peakTime,
            endTime: Math.min(duration, (i + windowSize) * timePerSample),
            intensity: envelope[i]
          });
        }
      }
    }

    return drops;
  }

  // Estimate BPM from beat markers
  private estimateBPM(beats: BeatMarker[]): number {
    if (beats.length < 4) return 120;

    const intervals: number[] = [];
    for (let i = 1; i < Math.min(beats.length, 50); i++) {
      intervals.push(beats[i].time - beats[i - 1].time);
    }

    intervals.sort((a, b) => a - b);
    const median = intervals[Math.floor(intervals.length / 2)];
    const filtered = intervals.filter(i => Math.abs(i - median) < median * 0.3);

    if (filtered.length === 0) return 120;

    const avgInterval = filtered.reduce((a, b) => a + b, 0) / filtered.length;
    let bpm = 60 / avgInterval;

    while (bpm < 80) bpm *= 2;
    while (bpm > 180) bpm /= 2;

    return Math.round(bpm);
  }

  // Assign musical phrase positions to beats
  private assignPhrasePositions(beats: BeatMarker[], barDuration: number, drops: DropZone[]): BeatMarker[] {
    const beatDuration = barDuration / 4;

    return beats.map(beat => {
      const barPosition = Math.round((beat.time % barDuration) / beatDuration) + 1;
      const isDownbeat = barPosition === 1;
      const phrasePosition = (Math.floor(beat.time / barDuration) % 8) + 1;
      const inDrop = drops.some(d => beat.time >= d.startTime && beat.time <= d.endTime);

      return {
        ...beat,
        isDownbeat,
        barPosition: Math.min(4, Math.max(1, barPosition)),
        phrasePosition,
        isDrop: inDrop
      };
    });
  }

  // Identify hero moments (high energy peaks)
  private identifyHeroMoments(beats: BeatMarker[], drops: DropZone[]): BeatMarker[] {
    return beats.map(beat => {
      const atDropPeak = drops.some(d => Math.abs(beat.time - d.peakTime) < 0.5);
      const isHighEnergy = beat.intensity > 0.8;

      return {
        ...beat,
        isHeroMoment: atDropPeak || (isHighEnergy && beat.isDownbeat)
      };
    });
  }
}

export const audioService = new AudioAnalyzerService();