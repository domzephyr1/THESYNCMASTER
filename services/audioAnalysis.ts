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

  // ... (Rest of your existing helper methods: getWaveformData, getEnergyEnvelope, detectDrops, estimateBPM, assignPhrasePositions, identifyHeroMoments, mergeBeats)
}

export const audioService = new AudioAnalyzerService();