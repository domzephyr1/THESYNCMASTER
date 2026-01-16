import { BeatMarker } from '../types';

declare var EssentiaWASM: any;
declare var Essentia: any;

export class AudioAnalyzerService {
  private audioContext: AudioContext;
  private essentia: any = null;

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

  async detectBeats(buffer: AudioBuffer, minEnergy: number = 0.1, sensitivity: number = 1.5): Promise<BeatMarker[]> {
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🎵 BEAT DETECTION STARTED");
    console.log(`   Duration: ${buffer.duration.toFixed(2)}s`);
    console.log(`   Settings: minEnergy=${minEnergy}, sensitivity=${sensitivity}`);

    // 1. Try Essentia AI Detection First (with timeout)
    let essentiaBeats: BeatMarker[] | null = null;
    const essentiaStartTime = performance.now();

    try {
      if (!this.essentia) {
        console.log("⏳ Loading Essentia.js...");
        await Promise.race([
          this.initEssentia(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Essentia load timeout')), 3000)
          )
        ]);
      }

      if (this.essentia) {
        console.log("✅ Essentia loaded, analyzing audio...");
        const channelData = buffer.getChannelData(0);

        const vectorSignal = this.essentia.arrayToVector(channelData);
        const rhythm = this.essentia.RhythmExtractor2013(vectorSignal);

        const ticks = this.essentia.vectorToArray(rhythm.ticks);
        const confidence = rhythm.confidence;
        const bpm = rhythm.bpm;

        // Cleanup memory (important for WASM)
        if(vectorSignal.delete) vectorSignal.delete();

        const essentiaTime = performance.now() - essentiaStartTime;

        console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
        console.log("📊 ESSENTIA RESULTS:");
        console.log(`   Beats found: ${ticks.length}`);
        console.log(`   BPM: ${bpm?.toFixed(1) || 'N/A'}`);
        console.log(`   Confidence: ${confidence?.toFixed(3) || 'N/A'}`);
        console.log(`   Processing time: ${essentiaTime.toFixed(0)}ms`);

        if (ticks.length > 5) { // Need at least 5 beats to be valid
          console.log(`   First 10 beats: ${ticks.slice(0, 10).map((t: number) => t.toFixed(2)).join(', ')}`);
          console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

          essentiaBeats = ticks.map((time: number) => ({
            time,
            intensity: Math.min(0.9, confidence || 0.8)
          }));
        } else {
          console.warn(`⚠️ Only ${ticks.length} beats detected, falling back to multi-band`);
        }
      } else {
        console.warn("⚠️ Essentia not available after init attempt");
      }
    } catch (e) {
      console.error("❌ Essentia failed:", e);
    }

    // Return Essentia beats if we got them
    if (essentiaBeats && essentiaBeats.length > 0) {
      return essentiaBeats;
    }

    // 2. Fallback to Multi-Band Detection
    const multibandStartTime = performance.now();
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🎛️ MULTI-BAND DETECTION (Fallback):");

    const lowPeaks = await this.analyzeBand(buffer, 'lowpass', 250, 1.2, minEnergy, sensitivity);
    console.log(`   Low freq (bass): ${lowPeaks.length} peaks`);

    const midPeaks = await this.analyzeBand(buffer, 'bandpass', 1200, 1.0, minEnergy, sensitivity);
    console.log(`   Mid freq: ${midPeaks.length} peaks`);

    const highPeaks = await this.analyzeBand(buffer, 'highpass', 4000, 0.8, minEnergy, sensitivity * 1.2);
    console.log(`   High freq: ${highPeaks.length} peaks`);

    const allPeaks = [...lowPeaks, ...midPeaks, ...highPeaks].sort((a, b) => a.time - b.time);
    const merged = this.mergeBeats(allPeaks, 0.15);

    const multibandTime = performance.now() - multibandStartTime;

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📊 MULTI-BAND RESULTS:");
    console.log(`   Total peaks before merge: ${allPeaks.length}`);
    console.log(`   Beats after merge: ${merged.length}`);
    console.log(`   Processing time: ${multibandTime.toFixed(0)}ms`);
    console.log(`   First 10 beats: ${merged.slice(0, 10).map(b => b.time.toFixed(2)).join(', ')}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

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
