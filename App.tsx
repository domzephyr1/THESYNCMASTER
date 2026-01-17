import React, { useState, useEffect, useCallback, useRef } from 'react';
import { AppStep, BeatMarker, VideoClip, EnhancedSyncSegment, StylePreset, PhraseData } from './types';
import { audioService } from './services/audioAnalysis';
import { videoAnalysisService } from './services/videoAnalysis';
import { renderService } from './services/renderService';
import { segmentationService } from './services/segmentationService';
import { STYLE_PRESETS, getPresetList } from './services/presetService';
import { sceneDetectionService, SceneMarker } from './services/sceneDetectionService';
import FileUpload from './components/FileUpload';
import Timeline from './components/Timeline';
import Player from './components/Player';
import ClipManager from './components/ClipManager';
import VideoTrimmer from './components/VideoTrimmer';
import { Zap, Download, Activity, Music as MusicIcon, Film, Key, ChevronLeft, Disc, Sliders, RefreshCw, Cpu, Layers, Gauge, Sparkles, Scissors } from 'lucide-react';

// Helpers
const formatTime = (time: number) => {
  const min = Math.floor(time / 60);
  const sec = Math.floor(time % 60);
  const ms = Math.floor((time % 1) * 100);
  return `${min}:${sec.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
};

function App() {
  const [step, setStep] = useState<AppStep>(AppStep.UPLOAD);
  
  // Data State
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [videoFiles, setVideoFiles] = useState<VideoClip[]>([]);
  const [audioUrl, setAudioUrl] = useState<string>('');
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [beats, setBeats] = useState<BeatMarker[]>([]);
  const [phraseData, setPhraseData] = useState<PhraseData | null>(null);
  const [waveformData, setWaveformData] = useState<number[]>([]);
  
  // Sync Logic State (Lifted Up)
  const [segments, setSegments] = useState<EnhancedSyncSegment[]>([]);
  const [estimatedBpm, setEstimatedBpm] = useState(0);
  const [syncScore, setSyncScore] = useState(0);

  // Analysis Settings
  const [minEnergy, setMinEnergy] = useState(0.1);
  const [peakSensitivity, setPeakSensitivity] = useState(1.8);
  const [enableSpeedRamping, setEnableSpeedRamping] = useState(false);
  const [enableSmartReorder, setEnableSmartReorder] = useState(false);
  const [currentPreset, setCurrentPreset] = useState<string>('musicVideo');
  
  // Playback State
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [seekSignal, setSeekSignal] = useState<number | null>(null);

  // Recording/Export State
  const [isRecording, setIsRecording] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isRendering, setIsRendering] = useState(false);
  const [renderProgress, setRenderProgress] = useState(0);

  // Modals
  const [showExportModal, setShowExportModal] = useState(false);
  const [trimmingClip, setTrimmingClip] = useState<VideoClip | null>(null);

  // Scene Detection State
  const [clipScenes, setClipScenes] = useState<Record<string, SceneMarker[]>>({});
  const [detectingScenes, setDetectingScenes] = useState<string | null>(null);

  // Toast notification state
  const [toast, setToast] = useState<string | null>(null);

  // Show toast helper
  const showToast = (message: string, duration: number = 2500) => {
    setToast(message);
    setTimeout(() => setToast(null), duration);
  };

  // Track Object URLs for cleanup to prevent memory leaks
  const urlsToRevoke = useRef<string[]>([]);

  // Cleanup URLs and timers on unmount
  useEffect(() => {
    return () => {
      urlsToRevoke.current.forEach(url => URL.revokeObjectURL(url));
      if (previewTimeoutRef.current) {
        clearTimeout(previewTimeoutRef.current);
      }
      if (autoResyncTimerRef.current) {
        clearTimeout(autoResyncTimerRef.current);
      }
    };
  }, []);

  // --- Handlers ---
  const handleAudioUpload = (files: FileList | null) => {
    if (files && files[0]) {
      // Revoke old audio URL if exists
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
      const file = files[0];
      setAudioFile(file);
      const url = URL.createObjectURL(file);
      urlsToRevoke.current.push(url);
      setAudioUrl(url);
    }
  };

  const handleVideoUpload = async (files: FileList | null) => {
    if (files) {
      const newClips: VideoClip[] = Array.from(files).map(file => {
        const url = URL.createObjectURL(file);
        urlsToRevoke.current.push(url); // Track for cleanup
        const clipId = Math.random().toString(36).substr(2, 9);

        // Metadata load for duration
        const tempVideo = document.createElement('video');
        tempVideo.src = url;
        tempVideo.onloadedmetadata = () => {
           setVideoFiles(prev => prev.map(c =>
             c.id === clipId ? { ...c, duration: tempVideo.duration, trimEnd: tempVideo.duration } : c
           ));
        };

        return {
          id: clipId,
          file,
          url,
          duration: 0,
          name: file.name,
          trimStart: 0,
          trimEnd: 0
        };
      });

      setVideoFiles(prev => [...prev, ...newClips]);

      // Trigger Async AI Analysis with proper error handling
      Promise.all(
        newClips.map(async (clip) => {
          try {
            const metadata = await videoAnalysisService.analyzeClip(clip.url);
            setVideoFiles(prev => prev.map(c =>
                c.id === clip.id ? { ...c, metadata } : c
            ));
          } catch (e) {
            console.warn(`Failed to analyze clip ${clip.name}:`, e);
          }
        })
      );
    }
  };

  const handleReorderClips = (fromIndex: number, toIndex: number) => {
     const updated = [...videoFiles];
     const [moved] = updated.splice(fromIndex, 1);
     updated.splice(toIndex, 0, moved);
     setVideoFiles(updated);
  };

  const handleRemoveClip = (id: string) => {
    // Revoke URL to free memory
    const clipToRemove = videoFiles.find(c => c.id === id);
    if (clipToRemove?.url) {
      URL.revokeObjectURL(clipToRemove.url);
      const urlIndex = urlsToRevoke.current.indexOf(clipToRemove.url);
      if (urlIndex > -1) {
        urlsToRevoke.current.splice(urlIndex, 1);
      }
    }
    setVideoFiles(prev => prev.filter(c => c.id !== id));
  };

  const handleTrimUpdate = (id: string, start: number, end: number) => {
     setVideoFiles(prev => prev.map(c =>
       c.id === id ? { ...c, trimStart: start, trimEnd: end } : c
     ));
  };

  // Detect scenes in a clip (for long clips)
  const detectScenesForClip = async (clipId: string, clipUrl: string) => {
    setDetectingScenes(clipId);
    try {
      const result = await sceneDetectionService.detectScenes(clipUrl);
      setClipScenes(prev => ({ ...prev, [clipId]: result.scenes }));
    } catch (e) {
      console.warn('Scene detection failed:', e);
    } finally {
      setDetectingScenes(null);
    }
  };

  // Auto-split a clip at scene boundaries
  const handleAutoSplitClip = async (clipId: string) => {
    const clip = videoFiles.find(c => c.id === clipId);
    const scenes = clipScenes[clipId];

    if (!clip || !scenes || scenes.length < 2) return;

    // Generate sub-clips from scene boundaries
    const ranges = sceneDetectionService.generateSubClipRanges(scenes, clip.duration);

    // Create new clips for each scene
    const newClips: VideoClip[] = ranges.map((range, index) => ({
      id: `${clipId}_scene_${index}`,
      file: clip.file,
      url: clip.url,
      duration: clip.duration,
      name: `${clip.name.replace(/\.[^/.]+$/, '')} (Scene ${index + 1})`,
      trimStart: range.start,
      trimEnd: range.end,
      metadata: clip.metadata
    }));

    // Replace original clip with split clips
    setVideoFiles(prev => {
      const index = prev.findIndex(c => c.id === clipId);
      if (index === -1) return prev;

      const updated = [...prev];
      updated.splice(index, 1, ...newClips);
      return updated;
    });

    // Clean up scene data for original clip
    setClipScenes(prev => {
      const updated = { ...prev };
      delete updated[clipId];
      return updated;
    });
  };

  // --- Core Sync Logic ---
  useEffect(() => {
    if (beats.length > 0 && videoFiles.length > 0 && duration > 0) {
        const result = segmentationService.generateMontage(beats, videoFiles, duration, {
          enableSpeedRamping,
          enableSmartReorder,
          preset: STYLE_PRESETS[currentPreset],
          phraseData: phraseData || undefined
        });
        setSegments(result.segments);
        setEstimatedBpm(result.bpm);
        setSyncScore(result.averageScore);
    }
  }, [beats, videoFiles, duration, enableSpeedRamping, enableSmartReorder, currentPreset, phraseData]);

  const handleShuffle = () => {
     if (beats.length > 0 && videoFiles.length > 0 && duration > 0) {
        const result = segmentationService.generateMontage(beats, videoFiles, duration, {
          enableSpeedRamping,
          enableSmartReorder,
          preset: STYLE_PRESETS[currentPreset],
          phraseData: phraseData || undefined
        });
        setSegments(result.segments);
        setSyncScore(result.averageScore);
    }
  };

  const handleBeatToggle = (time: number) => {
    // Check for nearby beat (0.15s window)
    const threshold = 0.15;
    const existingIndex = beats.findIndex(b => Math.abs(b.time - time) < threshold);

    let newBeats = [...beats];
    if (existingIndex >= 0) {
        // Remove
        newBeats.splice(existingIndex, 1);
    } else {
        // Add
        newBeats.push({ time, intensity: 1.0 });
    }
    
    // Sort
    newBeats.sort((a, b) => a.time - b.time);
    setBeats(newBeats);
  };

  const startAnalysis = async () => {
    if (!audioFile) return;
    setStep(AppStep.ANALYZING);
    setIsAnalyzing(true);

    try {
      const buffer = await audioService.decodeAudio(audioFile);
      setAudioBuffer(buffer);
      setDuration(buffer.duration);

      await new Promise(resolve => setTimeout(resolve, 500));

      const { beats: detectedBeats, phraseData: detectedPhraseData } = await audioService.detectBeatsEnhanced(buffer, minEnergy, peakSensitivity);
      setBeats(detectedBeats);
      setPhraseData(detectedPhraseData);

      const wave = audioService.getWaveformData(buffer, 300);
      setWaveformData(wave);

      setIsAnalyzing(false);
      setStep(AppStep.PREVIEW);
    } catch (err) {
      console.error("Analysis failed", err);
      alert("Could not decode audio. Please try a different file.");
      setIsAnalyzing(false);
      setStep(AppStep.UPLOAD);
    }
  };

  const handleReSync = useCallback(async () => {
    if (!audioBuffer) {
        console.warn("handleReSync: No audioBuffer available");
        return;
    }

    // Cancel any pending auto re-sync to prevent race condition
    if (autoResyncTimerRef.current) {
      clearTimeout(autoResyncTimerRef.current);
      autoResyncTimerRef.current = null;
    }

    console.log("🔄 Re-analyzing beats...", { minEnergy, peakSensitivity });
    setIsAnalyzing(true);
    try {
        const { beats: detectedBeats, phraseData: detectedPhraseData } = await audioService.detectBeatsEnhanced(audioBuffer, minEnergy, peakSensitivity);
        console.log(`✅ Detected ${detectedBeats.length} beats`);
        setBeats(detectedBeats);
        setPhraseData(detectedPhraseData);
        showToast(`✓ ${detectedBeats.length} beat markers synced!`);
    } catch(e) {
        console.error("Beat detection failed:", e);
        showToast("Beat detection failed");
    } finally {
        setIsAnalyzing(false);
    }
  }, [audioBuffer, minEnergy, peakSensitivity]);

  // Debounced Auto Re-Sync
  useEffect(() => {
    if (step === AppStep.PREVIEW && audioBuffer && !isAnalyzing) {
        autoResyncTimerRef.current = setTimeout(() => {
            handleReSync();
        }, 600);
        return () => {
          if (autoResyncTimerRef.current) {
            clearTimeout(autoResyncTimerRef.current);
            autoResyncTimerRef.current = null;
          }
        };
    }
  }, [minEnergy, peakSensitivity, step, audioBuffer, isAnalyzing, handleReSync]);

  // Apply style preset
  const applyPreset = (presetId: string) => {
      const preset = STYLE_PRESETS[presetId];
      if (preset) {
          setMinEnergy(preset.minEnergy);
          setPeakSensitivity(preset.sensitivity);
          setEnableSpeedRamping(preset.speedRamping);
          setCurrentPreset(presetId);
      }
  };

  const handleSeek = (time: number) => {
    if (isRecording) return;
    setSeekSignal(time);
    setCurrentTime(time);
  };

  // Track auto re-sync timer to prevent race conditions
  const autoResyncTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Beat Snap Preview: Play 2-second preview around the beat
  const previewTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const handleBeatPreview = (beatTime: number) => {
    if (isRecording) return;

    // Clear any existing preview timeout
    if (previewTimeoutRef.current) {
      clearTimeout(previewTimeoutRef.current);
    }

    // Seek to 0.5s before the beat
    const previewStart = Math.max(0, beatTime - 0.5);
    setSeekSignal(previewStart);
    setCurrentTime(previewStart);

    // Start playing
    setIsPlaying(true);

    // Stop after 2 seconds
    previewTimeoutRef.current = setTimeout(() => {
      setIsPlaying(false);
      previewTimeoutRef.current = null;
    }, 2000);
  };

  const startRecordingFlow = () => {
    setShowExportModal(false);
    setSeekSignal(0);
    setCurrentTime(0);
    setIsPlaying(false);
    setTimeout(() => {
       setIsRecording(true);
       setIsPlaying(true);
    }, 500);
  };

  const handleRecordingComplete = (blob: Blob) => {
    setIsRecording(false);
    setIsPlaying(false);
    
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = url;
    a.download = `syncmaster_record_${Date.now()}.webm`;
    document.body.appendChild(a);
    a.click();
    
    setTimeout(() => {
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      alert("Recording Saved!");
    }, 100);
  };

  // --- FFmpeg Export ---
  const handleFFmpegExport = async () => {
    if(!audioFile) return;
    
    setIsRendering(true);
    setRenderProgress(0);
    setShowExportModal(false);

    try {
        // Use the exact segments from state (WYSIWYG)
        const blob = await renderService.exportVideo(audioFile, segments, videoFiles, (p) => {
            setRenderProgress(Math.round(p * 100));
        });

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `syncmaster_hq_${Date.now()}.mp4`;
        document.body.appendChild(a);
        a.click();
        setIsRendering(false);
        alert("High Quality Render Complete!");

    } catch (e) {
        console.error(e);
        alert("Render failed. Most likely cause: This browser/host does not support SharedArrayBuffer (COOP/COEP headers missing). Try the 'Quick Record' option.");
        setIsRendering(false);
    }
  };


  useEffect(() => {
    if (isRecording && !isPlaying) {
      setIsRecording(false);
    }
  }, [isPlaying, isRecording]);


  const renderHeader = () => (
    <header className="flex items-center justify-between py-6 mb-8 border-b border-slate-800">
      <div className="flex items-center space-x-2">
        <Zap className="w-6 h-6 text-cyan-400 fill-current" />
        <h1 className="text-2xl font-bold tracking-tighter text-white font-mono">
          SYNC<span className="text-cyan-400">MASTER</span>
        </h1>
        {step === AppStep.PREVIEW && estimatedBpm > 0 && (
             <div className="hidden sm:flex ml-6 gap-3">
                 <div className="px-3 py-1 bg-slate-800/50 rounded-full flex items-center text-xs text-slate-300 font-mono border border-slate-700 animate-fade-in">
                     <MusicIcon className="w-3 h-3 mr-2 text-yellow-400" />
                     {estimatedBpm} BPM
                 </div>
                 {syncScore > 0 && (
                     <div className={`px-3 py-1 rounded-full flex items-center text-xs font-mono border animate-fade-in ${
                       syncScore >= 80 ? 'bg-green-500/20 border-green-500/50 text-green-400' :
                       syncScore >= 60 ? 'bg-yellow-500/20 border-yellow-500/50 text-yellow-400' :
                       'bg-red-500/20 border-red-500/50 text-red-400'
                     }`}>
                         <Gauge className="w-3 h-3 mr-2" />
                         Sync: {syncScore}%
                     </div>
                 )}
             </div>
        )}
      </div>
      <div className="flex items-center space-x-4">
        <div className={`px-3 py-1 rounded-full text-xs font-mono border ${step === AppStep.UPLOAD ? 'border-cyan-500 text-cyan-400' : 'border-slate-700 text-slate-500'}`}>
          1. UPLOAD
        </div>
        <div className="w-8 h-[1px] bg-slate-800"></div>
        <div className={`px-3 py-1 rounded-full text-xs font-mono border ${step === AppStep.ANALYZING || step === AppStep.PREVIEW ? 'border-cyan-500 text-cyan-400' : 'border-slate-700 text-slate-500'}`}>
          2. SYNC
        </div>
      </div>
    </header>
  );

  return (
    <div className="min-h-screen bg-cyber-black text-slate-200 selection:bg-cyan-500/30">
      <div className="max-w-4xl mx-auto px-4 md:px-8 pb-20">
        {renderHeader()}

        {/* STEP 1: UPLOAD */}
        {step === AppStep.UPLOAD && (
          <div className="space-y-8 animate-fade-in">
            <div className="grid md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <h2 className="text-lg font-semibold text-white flex items-center">
                  <MusicIcon className="w-5 h-5 mr-2 text-cyan-400" /> Source Audio
                </h2>
                <FileUpload 
                  label="Music Track" 
                  accept="audio/*" 
                  onFileSelect={handleAudioUpload}
                  selectedCount={audioFile ? 1 : 0}
                  icon="music"
                />
              </div>
              <div className="space-y-2">
                <h2 className="text-lg font-semibold text-white flex items-center">
                  <Film className="w-5 h-5 mr-2 text-cyan-400" /> Video Clips
                </h2>
                <FileUpload 
                  label="Clips" 
                  accept="video/*" 
                  multiple={true}
                  onFileSelect={handleVideoUpload}
                  selectedCount={videoFiles.length}
                  icon="video"
                />
              </div>
            </div>

            {/* Video List Manager */}
            {videoFiles.length > 0 && (
              <div className="mt-8">
                 <ClipManager
                   clips={videoFiles}
                   onReorder={handleReorderClips}
                   onRemove={handleRemoveClip}
                   onTrim={setTrimmingClip}
                   clipScenes={clipScenes}
                   detectingScenes={detectingScenes}
                   onDetectScenes={detectScenesForClip}
                   onAutoSplit={handleAutoSplitClip}
                 />
              </div>
            )}

            <div className="flex justify-center pt-8">
              <button
                disabled={!audioFile || videoFiles.length === 0}
                onClick={startAnalysis}
                className="group relative px-8 py-3 bg-cyan-600 hover:bg-cyan-500 disabled:bg-slate-800 disabled:text-slate-500 text-white font-bold rounded-lg transition-all duration-200 disabled:cursor-not-allowed shadow-[0_0_20px_rgba(8,145,178,0.4)] disabled:shadow-none overflow-hidden"
              >
                <div className="absolute inset-0 w-full h-full bg-gradient-to-r from-transparent via-white/20 to-transparent translate-x-[-100%] group-hover:translate-x-[100%] transition-transform duration-700"></div>
                <span className="flex items-center space-x-2">
                  <Activity className="w-5 h-5" />
                  <span>INITIATE SYNC ENGINE</span>
                </span>
              </button>
            </div>
          </div>
        )}

        {/* STEP 2: ANALYZING */}
        {step === AppStep.ANALYZING && (
          <div className="flex flex-col items-center justify-center h-64 space-y-4">
            <div className="relative w-24 h-24">
               <div className="absolute inset-0 border-t-4 border-cyan-500 rounded-full animate-spin"></div>
               <div className="absolute inset-2 border-r-4 border-yellow-500 rounded-full animate-spin reverse duration-200"></div>
            </div>
            <h2 className="text-xl font-mono text-cyan-400 animate-pulse">ANALYZING TRANSIENTS...</h2>
            <div className="flex items-center space-x-2 text-slate-500 text-sm">
                <Cpu className="w-4 h-4 text-cyan-500" />
                <span>AI Powered Analysis (Essentia + Spectral)</span>
            </div>
          </div>
        )}

        {/* STEP 3: PREVIEW */}
        {step === AppStep.PREVIEW && (
          <div className="space-y-6 animate-fade-in-up">
            
            <Player 
              audioUrl={audioUrl}
              videoClips={videoFiles}
              beats={beats}
              duration={duration}
              segments={segments}
              bpm={estimatedBpm}
              onTimeUpdate={setCurrentTime}
              isPlaying={isPlaying}
              onPlayToggle={setIsPlaying}
              seekTime={seekSignal}
              isRecording={isRecording}
              onRecordingComplete={handleRecordingComplete}
            />

            <div className={`space-y-2 transition-opacity ${isRecording ? 'opacity-50 pointer-events-none' : 'opacity-100'}`}>
               <div className="flex justify-between text-xs font-mono text-slate-400">
                  <span>{formatTime(currentTime)}</span>
                  <span>{formatTime(duration)}</span>
               </div>
               <Timeline
                 waveformData={waveformData}
                 beats={beats}
                 duration={duration}
                 currentTime={currentTime}
                 onSeek={handleSeek}
                 onBeatToggle={handleBeatToggle}
                 onBeatPreview={handleBeatPreview}
               />
               <div className="flex justify-between items-center text-xs text-slate-500">
                  <div className="flex items-center">
                    <div className="w-3 h-3 bg-yellow-500 rounded-full mr-2"></div>
                    <span>Beat Markers Detected: {beats.length}</span>
                  </div>
                  <span className="flex items-center">
                      <Layers className="w-3 h-3 mr-1" />
                      Source: Hybrid AI
                  </span>
               </div>
            </div>

            <div className={`p-4 bg-slate-900/50 border border-slate-800 rounded-lg transition-opacity ${isRecording ? 'opacity-50 pointer-events-none' : 'opacity-100'}`}>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center">
                   <Sliders className="w-4 h-4 text-cyan-400 mr-2" />
                   <h3 className="text-sm font-bold text-slate-300 uppercase">Sync Fine-Tuning</h3>
                </div>
                {/* Style Presets */}
                <div className="flex flex-wrap gap-1">
                    {getPresetList().slice(0, 4).map((preset) => (
                        <button
                          key={preset.id}
                          onClick={() => applyPreset(preset.id)}
                          title={preset.description}
                          className={`px-2 py-1 text-[10px] uppercase font-bold rounded transition-colors ${
                            currentPreset === preset.id
                              ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500'
                              : 'text-slate-400 border border-slate-700 hover:text-white hover:border-cyan-500'
                          }`}
                        >
                          {preset.name}
                        </button>
                    ))}
                </div>
              </div>
              
              <div className="grid md:grid-cols-2 gap-6">
                 <div className="space-y-2">
                    <div className="flex justify-between text-xs text-slate-400">
                       <label>Min Energy (Threshold)</label>
                       <span>{minEnergy.toFixed(2)}</span>
                    </div>
                    <input 
                      type="range" 
                      min="0.01" 
                      max="0.8" 
                      step="0.01"
                      value={minEnergy}
                      onChange={(e) => setMinEnergy(parseFloat(e.target.value))}
                      className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
                    />
                 </div>

                 <div className="space-y-2">
                    <div className="flex justify-between text-xs text-slate-400">
                       <label>Dynamic Sensitivity</label>
                       <span>{peakSensitivity.toFixed(1)}x</span>
                    </div>
                    <input
                      type="range"
                      min="1.0"
                      max="4.0"
                      step="0.1"
                      value={peakSensitivity}
                      onChange={(e) => setPeakSensitivity(parseFloat(e.target.value))}
                      className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-yellow-500"
                    />
                 </div>
              </div>

              {/* Feature Toggles */}
              <div className="flex flex-wrap gap-4 mt-4 pt-4 border-t border-slate-800">
                <label className="flex items-center gap-2 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={enableSpeedRamping}
                    onChange={(e) => setEnableSpeedRamping(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-cyan-500 focus:ring-cyan-500 focus:ring-offset-slate-900"
                  />
                  <span className="text-xs text-slate-400 group-hover:text-white transition-colors flex items-center gap-1">
                    <Sparkles className="w-3 h-3 text-yellow-400" />
                    Speed Ramping
                  </span>
                  <span className="text-[10px] text-slate-600">(slow-mo on quiet, speed up on drops)</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={enableSmartReorder}
                    onChange={(e) => setEnableSmartReorder(e.target.checked)}
                    className="w-4 h-4 rounded border-slate-600 bg-slate-800 text-cyan-500 focus:ring-cyan-500 focus:ring-offset-slate-900"
                  />
                  <span className="text-xs text-slate-400 group-hover:text-white transition-colors flex items-center gap-1">
                    <Layers className="w-3 h-3 text-cyan-400" />
                    Smart Clip Flow
                  </span>
                  <span className="text-[10px] text-slate-600">(smoother visual transitions)</span>
                </label>
              </div>

              <div className="flex justify-end mt-4 items-center space-x-2">
                 {isAnalyzing && (
                     <span className="text-xs text-cyan-400 animate-pulse">Syncing to rhythm...</span>
                 )}
                <button 
                  onClick={handleReSync}
                  disabled={isAnalyzing}
                  className="flex items-center px-4 py-2 bg-slate-800 hover:bg-slate-700 text-cyan-400 text-xs font-bold rounded border border-slate-700 hover:border-cyan-500 transition-all disabled:opacity-50"
                >
                  <RefreshCw className={`w-3 h-3 mr-2 ${isAnalyzing ? 'animate-spin' : ''}`} />
                  {isAnalyzing ? 'ANALYZING...' : 'RE-ANALYZE BEATS'}
                </button>
              </div>
            </div>

            <div className={`pt-8 border-t border-slate-800 transition-opacity ${isRecording ? 'opacity-50 pointer-events-none' : 'opacity-100'}`}>
               <h3 className="text-sm font-bold text-slate-500 mb-4">SEQUENCER (EDIT MODE)</h3>
               <ClipManager
                  clips={videoFiles}
                  segments={segments}
                  onReorder={handleReorderClips}
                  onRemove={handleRemoveClip}
                  onTrim={setTrimmingClip}
                  onShuffle={handleShuffle}
                  clipScenes={clipScenes}
                  detectingScenes={detectingScenes}
                  onDetectScenes={detectScenesForClip}
                  onAutoSplit={handleAutoSplitClip}
               />
            </div>

            <div className={`flex justify-between items-center pt-8 border-t border-slate-800 mt-8 transition-opacity ${isRecording ? 'opacity-50 pointer-events-none' : 'opacity-100'}`}>
              <button
                onClick={() => {
                   setIsPlaying(false);
                   setStep(AppStep.UPLOAD);
                   setAudioFile(null);
                   setVideoFiles([]);
                   // Clean up all Object URLs to free memory
                   urlsToRevoke.current.forEach(url => URL.revokeObjectURL(url));
                   urlsToRevoke.current = [];
                   setAudioUrl('');
                   setBeats([]);
                   setSegments([]);
                }}
                className="flex items-center text-sm text-slate-500 hover:text-white transition-colors"
              >
                <ChevronLeft className="w-4 h-4 mr-1" />
                Start Over
              </button>
              
              <button
                onClick={() => setShowExportModal(true)}
                className="flex items-center px-6 py-2 bg-slate-100 hover:bg-white text-slate-900 font-bold rounded shadow-[0_0_15px_rgba(255,255,255,0.2)] transition-all"
              >
                <Download className="w-4 h-4 mr-2" />
                EXPORT MONTAGE
              </button>
            </div>
          </div>
        )}

        {/* Rendering Overlay */}
        {isRendering && (
            <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center bg-black/95">
                <div className="w-64 space-y-4">
                    <div className="flex justify-between text-cyan-400 font-mono text-sm">
                        <span>RENDERING VIDEO</span>
                        <span>{renderProgress}%</span>
                    </div>
                    <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
                        <div className="h-full bg-cyan-500 transition-all duration-300" style={{ width: `${renderProgress}%` }}></div>
                    </div>
                    <p className="text-xs text-slate-500 text-center animate-pulse">Running FFmpeg Wasm Core...</p>
                </div>
            </div>
        )}

        {showExportModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <div className="bg-slate-900 border border-slate-700 rounded-xl p-6 max-w-md w-full shadow-2xl space-y-6">
              <h3 className="text-xl font-bold text-white flex items-center">
                <Key className="w-5 h-5 mr-2 text-yellow-400" /> Export Options
              </h3>
              
              <div className="space-y-3">
                 <h4 className="text-sm font-semibold text-cyan-400 uppercase tracking-wider">Option A: Quick Record</h4>
                 <p className="text-xs text-slate-400">
                    Real-time capture. Good for preview.
                 </p>
                 <button 
                   onClick={startRecordingFlow}
                   className="w-full flex items-center justify-center py-3 bg-slate-800 hover:bg-slate-700 text-white font-bold rounded transition-colors"
                 >
                   <Disc className="w-5 h-5 mr-2" />
                   Record .WEBM
                 </button>
              </div>

              <div className="space-y-3">
                 <h4 className="text-sm font-semibold text-yellow-400 uppercase tracking-wider">Option B: High Quality Render</h4>
                 <p className="text-xs text-slate-400">
                    Frame-perfect assembly using FFmpeg. (Slower)
                 </p>
                 <button 
                   onClick={handleFFmpegExport}
                   className="w-full flex items-center justify-center py-3 bg-cyan-600 hover:bg-cyan-500 text-white font-bold rounded transition-colors shadow-lg shadow-cyan-500/20"
                 >
                   <Cpu className="w-5 h-5 mr-2" />
                   Render .MP4 (FFmpeg)
                 </button>
              </div>

              <button 
                onClick={() => setShowExportModal(false)}
                className="w-full pt-2 text-xs text-slate-500 hover:text-white transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {trimmingClip && (
          <VideoTrimmer
            clip={trimmingClip}
            onSave={handleTrimUpdate}
            onClose={() => setTrimmingClip(null)}
          />
        )}

        {/* Toast Notification */}
        {toast && (
          <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[100] animate-fade-in-up">
            <div className="px-6 py-3 bg-slate-800 border border-cyan-500/50 rounded-lg shadow-lg shadow-cyan-500/20 text-cyan-400 font-mono text-sm flex items-center gap-2">
              <Zap className="w-4 h-4" />
              {toast}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;