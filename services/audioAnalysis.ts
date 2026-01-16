import { BeatMarker } from '../types';

declare var EssentiaWASM: any;
declare var Essentia: any;

export class AudioAnalyzerService {
  private audioContext: AudioContext;
  private essentia: any = null;

  constructor() {
    this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    // Removed automatic init to lazy load on first use
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
    // Wait for scripts to load
    const maxRetries = 20;
    let attempts = 0;

    return new Promise<void>((resolve) => {
        const check = async () => {
            if (typeof EssentiaWASM !== 'undefined' && typeof Essentia !== 'undefined') {
                try {
                    // EssentiaWASM is a function that returns a promise
                    const wasmModule = await EssentiaWASM();
                    this.essentia = new Essentia(wasmModule);
                    console.log("✅ Essentia.js (Spotify AI) Initialized");
                    resolve();
                } catch (e) {
                    console.warn("Essentia init error", e);
                    resolve(); // Resolve anyway to fallback
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
    console.log("🎵 detectBeats called", { duration: buffer.duration, minEnergy, sensitivity });

    // 1. Try Essentia AI Detection First (Lazy Load)
    if (!this.essentia) {
        console.log("Initializing Essentia...");
        await this.initEssentia();
    }

    if (this.essentia) {
        try {
            console.log("Running Essentia RhythmExtractor2013...");
            const channelData = buffer.getChannelData(0);

            // Convert to vector for Essentia
            const vectorSignal = this.essentia.arrayToVector(channelData);

            // Use RhythmExtractor2013 (Standard for music analysis)
            const rhythm = this.essentia.RhythmExtractor2013(vectorSignal);

            // Output: ticks (beat positions in seconds), bpm, confidence
            const ticks = this.essentia.vectorToArray(rhythm.ticks);
            const confidence = rhythm.confidence;

            // Cleanup memory (important for WASM)
            if(vectorSignal.delete) vectorSignal.delete();

            if (ticks.length > 0) {
                console.log(`✅ Essentia found ${ticks.length} beats with ${confidence} confidence.`);
                return ticks.map((time: number) => ({
                    time,
                    intensity: 0.8
                }));
            } else {
                console.warn("Essentia returned 0 beats, falling back");
            }
        } catch (e) {
            console.warn("Essentia analysis failed, falling back to Multi-Band", e);
        }
    } else {
        console.log("Essentia not available, using Multi-Band fallback");
    }

    // 2. Fallback to Multi-Band Algo
    console.log("🔊 Using Multi-Band Frequency Analysis");
    const lowPeaks = await this.analyzeBand(buffer, 'lowpass', 250, 1.2, minEnergy, sensitivity);
    const midPeaks = await this.analyzeBand(buffer, 'bandpass', 1200, 1.0, minEnergy, sensitivity);
    const highPeaks = await this.analyzeBand(buffer, 'highpass', 4000, 0.8, minEnergy, sensitivity * 1.2);

    console.log(`  Bands: low=${lowPeaks.length}, mid=${midPeaks.length}, high=${highPeaks.length}`);

    const allPeaks = [...lowPeaks, ...midPeaks, ...highPeaks].sort((a, b) => a.time - b.time);
    const merged = this.mergeBeats(allPeaks, 0.15);

    console.log(`✅ Multi-Band found ${merged.length} beats`);
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