import { BeatMarker } from '../types';

declare var EssentiaWASM: any;
declare var Essentia: any;

export class AudioAnalyzerService {
  private audioContext: AudioContext;
  private essentia: any = null;

  // Cache raw Essentia beats to avoid re-running 50s analysis
  private cachedRawBeats: BeatMarker[] | null = null;
  private cachedAudioDuration: number = 0;

  constructor() {
    this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  }

  // Calculate energy envelope for the entire track (for speed ramping)
  getEnergyEnvelope(buffer: AudioBuffer, windowCount: number = 100): number[] {
    const rawData = buffer.getChannelData(0);
    const windowSize = Math.floor(rawData.length / windowCount);
    const envelope: number[] = [];

    for (let i = 0; i < windowCount; i++) {
      const start = i * windowSize;
      let sum = 0;
      for (let j = 0; j < windowSize && start + j < rawData.length; j++) {
        sum += rawData[start + j] * rawData[start + j];
      }
      envelope.push(Math.sqrt(sum / windowSize));
    }

    // Normalize
    const max = Math.max(...envelope);
    return envelope.map(v => v / max);
  }

  // Get energy at a specific time
  private getEnergyAtTime(buffer: AudioBuffer, time: number, windowMs: number = 100): number {
    const sampleRate = buffer.sampleRate;
    const rawData = buffer.getChannelData(0);
    const centerSample = Math.floor(time * sampleRate);
    const windowSamples = Math.floor((windowMs / 1000) * sampleRate);
    const start = Math.max(0, centerSample - windowSamples / 2);
    const end = Math.min(rawData.length, centerSample + windowSamples / 2);

    let sum = 0;
    for (let i = start; i < end; i++) {
      sum += rawData[i] * rawData[i];
    }
    return Math.sqrt(sum / (end - start));
  }

  private async initEssentia() {
    const maxRetries = 10; // Reduced from 20 for faster fallback
    let attempts = 0;

    return new Promise<void>((resolve) => {
        const check = async () => {
            if (typeof EssentiaWASM !== 'undefined' && typeof Essentia !== 'undefined') {
                try {
                    // EssentiaWASM is a function that returns a promise
                    const wasmModule = await EssentiaWASM();
                    this.essentia = new Essentia(wasmModule);
                    console.log("✅ Essentia.js initialized");
                    resolve();
                } catch (e) {
                    console.warn("⚠️ Essentia init error:", e);
                    resolve(); // Resolve anyway to fallback
                }
            } else if (attempts < maxRetries) {
                attempts++;
                setTimeout(check, 100);
            } else {
                console.warn("⚠️ Essentia timeout - using fallback detection");
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
    const rawData = buffer.getChannelData(0); // Use first channel
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

    // Normalize
    const max = Math.max(...waveform);
    return waveform.map(val => val / max);
  }

  // Post-process beats based on user settings (minEnergy and sensitivity)
  // Goal: Reduce 400+ raw beats to 30-100 usable cut points for video editing
  private postProcessBeats(rawBeats: BeatMarker[], minEnergy: number, sensitivity: number): BeatMarker[] {
    if (rawBeats.length === 0) return [];

    // minEnergy controls minimum interval between beats
    // Higher minEnergy = longer intervals = fewer cuts
    // Range: 0.5s (minEnergy=0.01) to 4s (minEnergy=0.8)
    const minInterval = 0.5 + (minEnergy * 4);

    // sensitivity controls the target beat density
    // Higher sensitivity = more beats kept
    // Range: keep every 8th beat (sens=1.0) to every 2nd beat (sens=4.0)
    const skipFactor = Math.max(1, Math.round(9 - sensitivity * 2));

    const filteredBeats: BeatMarker[] = [];
    let lastBeatTime = -minInterval;
    let beatCounter = 0;

    for (const beat of rawBeats) {
      // Must be at least minInterval apart
      if (beat.time - lastBeatTime >= minInterval) {
        beatCounter++;
        // Only keep every Nth beat based on sensitivity
        if (beatCounter % skipFactor === 0 || beat.intensity > 0.9) {
          filteredBeats.push(beat);
          lastBeatTime = beat.time;
        }
      }
    }

    console.log(`🎚️ Beat filter: ${rawBeats.length} → ${filteredBeats.length} (interval=${minInterval.toFixed(1)}s, skip=${skipFactor})`);
    return filteredBeats;
  }

  async detectBeats(buffer: AudioBuffer, minEnergy: number = 0.1, sensitivity: number = 1.5): Promise<BeatMarker[]> {
    console.log(`🎵 Beat detection: ${buffer.duration.toFixed(1)}s audio`);

    // Check if we have cached raw beats for this audio (same duration = same audio)
    if (this.cachedRawBeats && Math.abs(this.cachedAudioDuration - buffer.duration) < 0.1) {
      console.log("⚡ Using cached Essentia beats (instant re-filter)");
      return this.postProcessBeats(this.cachedRawBeats, minEnergy, sensitivity);
    }

    // 1. Try Essentia AI Detection First (with timeout)
    let essentiaBeats: BeatMarker[] | null = null;

    try {
      if (!this.essentia) {
        await Promise.race([
          this.initEssentia(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Essentia load timeout')), 3000)
          )
        ]);
      }

      if (this.essentia) {
        const channelData = buffer.getChannelData(0);
        const vectorSignal = this.essentia.arrayToVector(channelData);
        const rhythm = this.essentia.RhythmExtractor2013(vectorSignal);

        const ticks = this.essentia.vectorToArray(rhythm.ticks);
        const confidence = rhythm.confidence;
        const bpm = rhythm.bpm;

        // Cleanup memory (important for WASM)
        if(vectorSignal.delete) vectorSignal.delete();

        if (ticks.length > 5) { // Need at least 5 beats to be valid
          // CRITICAL: Convert Float32Array to regular Array before mapping to objects
          essentiaBeats = Array.from(ticks).map((time: number) => ({
            time,
            intensity: Math.min(0.9, confidence || 0.8)
          }));
          console.log(`✅ Essentia: ${essentiaBeats.length} beats at ${bpm?.toFixed(0) || '?'} BPM`);
        }
      }
    } catch (e) {
      console.warn("Essentia unavailable, using fallback");
    }

    // Return Essentia beats if we got them (with post-processing based on user settings)
    if (essentiaBeats && essentiaBeats.length > 0) {
      // Cache raw beats for instant re-filtering
      this.cachedRawBeats = essentiaBeats;
      this.cachedAudioDuration = buffer.duration;
      return this.postProcessBeats(essentiaBeats, minEnergy, sensitivity);
    }

    // 2. Fallback to Multi-Band Detection
    console.log("🎛️ Using multi-band fallback detection");

    const lowPeaks = await this.analyzeBand(buffer, 'lowpass', 250, 1.2, minEnergy, sensitivity);
    const midPeaks = await this.analyzeBand(buffer, 'bandpass', 1200, 1.0, minEnergy, sensitivity);
    const highPeaks = await this.analyzeBand(buffer, 'highpass', 4000, 0.8, minEnergy, sensitivity * 1.2);

    const allPeaks = [...lowPeaks, ...midPeaks, ...highPeaks].sort((a, b) => a.time - b.time);
    const merged = this.mergeBeats(allPeaks, 0.15);

    console.log(`✅ Multi-band: ${merged.length} beats detected`);
    return merged;
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

    const minBeatInterval = 0.25;
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
