import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { AppStep, BeatMarker, VideoClip, EnhancedSyncSegment, StylePreset, PhraseData } from './types';
import { audioService } from './services/audioAnalysis';
import { videoAnalysisService } from './services/videoAnalysis';
import { renderService } from './services/renderService';
import { segmentationService } from './services/segmentationService';
import { STYLE_PRESETS, getPresetList } from './services/presetService';
import { sceneDetectionService, SceneMarker } from './services/sceneDetectionService';
import FileUpload from './components/FileUpload';
import Timeline from './components/Timeline';
import SegmentTrack from './components/SegmentTrack';
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

// Process array items in batches to avoid overwhelming the browser
async function processBatched<T, R>(
  items: T[],
  batchSize: number,
  processor: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map((item, batchIndex) => processor(item, i + batchIndex))
    );
    results.push(...batchResults);
  }
  return results;
}

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

        // Metadata load for duration - properly clean up temp video element
        const tempVideo = document.createElement('video');
        tempVideo.src = url;
        tempVideo.onloadedmetadata = () => {
          const videoDuration = tempVideo.duration;
          // Clean up temp video element immediately after getting metadata
          tempVideo.src = '';
          tempVideo.load();

          setVideoFiles(prev => prev.map(c =>
            c.id === clipId ? { ...c, duration: videoDuration, trimEnd: videoDuration } : c
          ));
        };
        tempVideo.onerror = () => {
          // Clean up on error too
          tempVideo.src = '';
          tempVideo.load();
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

      // Trigger Async AI Analysis with batched state updates
      Promise.all(
        newClips.map(async (clip) => {
          try {
            const metadata = await videoAnalysisService.analyzeClip(clip.url);
            return { clipId: clip.id, metadata };
          } catch (e) {
            console.warn(`Failed to analyze clip ${clip.name}:`, e);
            return { clipId: clip.id, metadata: { brightness: 0.5, contrast: 0.5, motionEnergy: 0.5, processed: true } };
          }
        })
      ).then(results => {
        // Batch update all metadata at once instead of 42 individual updates
        setVideoFiles(prev => prev.map(c => {
          const result = results.find(r => r.clipId === c.id);
          return result ? { ...c, metadata: result.metadata } : c;
        }));
      });
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

  const handleShuffle = useCallback(() => {
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
  }, [beats, videoFiles, duration, enableSpeedRamping, enableSmartReorder, currentPreset, phraseData]);

  const handleBeatToggle = useCallback((time: number) => {
    setBeats(prevBeats => {
      // Check for nearby beat (0.15s window)
      const threshold = 0.15;
      const existingIndex = prevBeats.findIndex(b => Math.abs(b.time - time) < threshold);

      let newBeats = [...prevBeats];
      if (existingIndex >= 0) {
          // Remove
          newBeats.splice(existingIndex, 1);
      } else {
          // Add
          newBeats.push({ time, intensity: 1.0 });
      }

      // Sort
      newBeats.sort((a, b) => a.time - b.time);
      return newBeats;
    });
  }, []);

  const startAnalysis = async () => {
    if (!audioFile) return;
    setStep(AppStep.ANALYZING);
    setIsAnalyzing(true);

    try {
      const totalClips = videoFiles.length;

      // ========== STEP 1: Decode Audio ==========
      console.log("📊 Step 1/6: Decoding audio...");
      const buffer = await audioService.decodeAudio(audioFile);
      setAudioBuffer(buffer);
      setDuration(buffer.duration);

      // ========== STEP 2: Load ALL Video Metadata ==========
      console.log("📊 Step 2/6: Loading video metadata...");
      const videosWithDuration = await Promise.all(
        videoFiles.map(clip => {
          return new Promise<VideoClip>((resolve) => {
            if (clip.duration > 0) {
              resolve(clip);
              return;
            }
            const video = document.createElement('video');
            video.src = clip.url;

            const cleanup = () => {
              video.src = '';
              video.load();
            };

            video.onloadedmetadata = () => {
              const updatedClip = { ...clip, duration: video.duration, trimEnd: video.duration };
              cleanup();
              resolve(updatedClip);
            };
            video.onerror = () => {
              cleanup();
              resolve(clip);
            };
            setTimeout(() => {
              cleanup();
              resolve(clip);
            }, 5000); // 5s timeout
          });
        })
      );

      // ========== STEP 3: Run AI Analysis on ALL Clips ==========
      console.log(`📊 Step 3/6: Analyzing ${totalClips} video clips (motion, brightness, contrast)...`);
      // Process in batches of 8 to avoid overwhelming the browser
      const videosWithMetadata = await processBatched(
        videosWithDuration,
        8,
        async (clip, index) => {
          // Skip if already analyzed
          if (clip.metadata?.processed) {
            console.log(`  ✓ Clip ${index + 1}/${totalClips}: ${clip.name} (cached)`);
            return clip;
          }

          try {
            console.log(`  → Analyzing clip ${index + 1}/${totalClips}: ${clip.name}...`);
            const metadata = await videoAnalysisService.analyzeClip(clip.url);
            console.log(`  ✓ Clip ${index + 1}/${totalClips}: brightness=${metadata.brightness?.toFixed(2)}, motion=${metadata.motionEnergy?.toFixed(2)}`);
            return { ...clip, metadata };
          } catch (e) {
            console.warn(`  ✗ Clip ${index + 1} analysis failed:`, e);
            return { ...clip, metadata: { brightness: 0.5, contrast: 0.5, motionEnergy: 0.5, processed: true } };
          }
        }
      );

      // Update state with fully analyzed clips
      setVideoFiles(videosWithMetadata);

      // ========== STEP 4: Detect Beats ==========
      console.log("📊 Step 4/6: Analyzing audio beats and rhythm...");
      const { beats: detectedBeats, phraseData: detectedPhraseData } = await audioService.detectBeatsEnhanced(buffer, minEnergy, peakSensitivity);
      setBeats(detectedBeats);
      setPhraseData(detectedPhraseData);

      const wave = audioService.getWaveformData(buffer, 300);
      setWaveformData(wave);

      // ========== STEP 5: Generate Sync Segments ==========
      console.log("📊 Step 5/6: Computing optimal sync cuts...");
      let generatedSegments: EnhancedSyncSegment[] = [];
      if (detectedBeats.length > 0 && videosWithMetadata.length > 0) {
        const result = segmentationService.generateMontage(detectedBeats, videosWithMetadata, buffer.duration, {
          enableSpeedRamping,
          enableSmartReorder,
          preset: STYLE_PRESETS[currentPreset],
          phraseData: detectedPhraseData || undefined
        });
        generatedSegments = result.segments;
        setSegments(result.segments);
        setEstimatedBpm(result.bpm);
        setSyncScore(result.averageScore);
      }

      // ========== STEP 6: Pre-buffer ALL Videos ==========
      console.log(`📊 Step 6/6: Pre-buffering ${totalClips} videos for smooth playback...`);
      await Promise.all(
        videosWithMetadata.map((clip, index) => {
          return new Promise<void>((resolve) => {
            const video = document.createElement('video');
            video.src = clip.url;
            video.preload = 'auto';
            video.muted = true;

            // Cleanup function to free temp video element
            const cleanup = () => {
              video.onseeked = null;
              video.oncanplaythrough = null;
              video.onerror = null;
              video.src = '';
              video.load();
            };

            // Seek to a few key positions to force buffering
            const seekPositions = [0, 0.25, 0.5, 0.75].map(p => p * (clip.duration || 1));
            let currentSeek = 0;
            let resolved = false;

            const doResolve = () => {
              if (!resolved) {
                resolved = true;
                cleanup();
                resolve();
              }
            };

            const doSeek = () => {
              if (currentSeek < seekPositions.length) {
                video.currentTime = seekPositions[currentSeek];
                currentSeek++;
              } else {
                console.log(`  ✓ Buffered clip ${index + 1}/${totalClips}`);
                doResolve();
              }
            };

            video.onseeked = doSeek;
            video.oncanplaythrough = () => {
              if (currentSeek === 0) doSeek(); // Start seeking
            };
            video.onerror = () => {
              console.warn(`  ✗ Failed to buffer clip ${index + 1}`);
              doResolve();
            };

            // Timeout fallback - 3s per clip
            setTimeout(() => {
              console.log(`  ⏱ Clip ${index + 1}/${totalClips} buffer timeout (continuing...)`);
              doResolve();
            }, 3000);

            video.load();
          });
        })
      );

      console.log("🎬 Analysis complete! Ready to preview.");
      console.log(`   ${detectedBeats.length} beats | ${generatedSegments.length} segments | ${totalClips} clips analyzed`);

      setIsAnalyzing(false);
      setStep(AppStep.PREVIEW);
    } catch (err) {
      console.error("Analysis failed", err);

      // Clean up any created URLs to prevent memory leaks on error
      urlsToRevoke.current.forEach(url => URL.revokeObjectURL(url));
      urlsToRevoke.current = [];

      // Reset all state
      setAudioFile(null);
      setAudioUrl('');
      setAudioBuffer(null);
      setVideoFiles([]);
      setBeats([]);
      setSegments([]);
      setWaveformData([]);
      setDuration(0);

      setIsAnalyzing(false);
      setStep(AppStep.UPLOAD);

      // Show more helpful error message
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      alert(`Analysis failed: ${errorMessage}\n\nPlease try a different audio file or check that your video files are valid.`);
    }
  };

  const handleReSync = useCallback(async () => {
    if (!audioBuffer) {
        console.warn("handleReSync: No audioBuffer available");
        showToast("No audio loaded - please reload the page");
        return;
    }

    // Cancel any pending auto re-sync to prevent race condition
    if (autoResyncTimerRef.current) {
      clearTimeout(autoResyncTimerRef.current);
      autoResyncTimerRef.current = null;
    }

    // ALWAYS pause and reset - use longer delay to ensure state propagates
    setIsPlaying(false);
    setSeekSignal(0);

    // Wait for React to flush state updates and player to actually stop
    await new Promise(resolve => setTimeout(resolve, 150));

    setSeekSignal(null);

    console.log("🔄 Re-analyzing beats...", { minEnergy, peakSensitivity });
    setIsAnalyzing(true);
    try {
        // Step 1: Detect new beats
        const { beats: detectedBeats, phraseData: detectedPhraseData } = await audioService.detectBeatsEnhanced(audioBuffer, minEnergy, peakSensitivity);
        console.log(`✅ Detected ${detectedBeats.length} beats`);
        setBeats(detectedBeats);
        setPhraseData(detectedPhraseData);

        // Step 2: Regenerate segments with new beats
        if (detectedBeats.length > 0 && videoFiles.length > 0) {
            console.log("🎬 Regenerating segments...");
            const result = segmentationService.generateMontage(detectedBeats, videoFiles, audioBuffer.duration, {
                enableSpeedRamping,
                enableSmartReorder,
                preset: STYLE_PRESETS[currentPreset],
                phraseData: detectedPhraseData || undefined
            });
            setSegments(result.segments);
            setEstimatedBpm(result.bpm);
            setSyncScore(result.averageScore);
            console.log(`✅ Generated ${result.segments.length} segments`);
            showToast(`✓ ${detectedBeats.length} beats → ${result.segments.length} segments`);
        } else {
            showToast(`✓ ${detectedBeats.length} beat markers detected`);
        }
    } catch(e) {
        console.error("Beat detection failed:", e);
        showToast("Beat detection failed");
    } finally {
        setIsAnalyzing(false);
    }
  }, [audioBuffer, minEnergy, peakSensitivity, videoFiles, enableSpeedRamping, enableSmartReorder, currentPreset, isAnalyzing, isPlaying]);

  // Auto Re-Sync DISABLED - only re-analyze when user clicks the button
  // useEffect(() => {
  //   if (step === AppStep.PREVIEW && audioBuffer && !isAnalyzing) {
  //       autoResyncTimerRef.current = setTimeout(() => {
  //           handleReSync();
  //       }, 600);
  //       return () => {
  //         if (autoResyncTimerRef.current) {
  //           clearTimeout(autoResyncTimerRef.current);
  //           autoResyncTimerRef.current = null;
  //         }
  //       };
  //   }
  // }, [minEnergy, peakSensitivity, step, audioBuffer, isAnalyzing, handleReSync]);

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

  const handleSeek = useCallback((time: number) => {
    if (isRecording) return;
    setSeekSignal(time);
    setCurrentTime(time);
  }, [isRecording]);

  // Track auto re-sync timer to prevent race conditions
  const autoResyncTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Beat Snap Preview: Play 2-second preview around the beat
  const previewTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const handleBeatPreview = useCallback((beatTime: number) => {
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
  }, [isRecording]);

  // Handle segment updates from SegmentTrack editor
  const handleSegmentUpdate = useCallback((index: number, updates: Partial<EnhancedSyncSegment>) => {
    setSegments(prev => {
      const newSegments = [...prev];
      if (index >= 0 && index < newSegments.length) {
        newSegments[index] = { ...newSegments[index], ...updates };
      }
      return newSegments;
    });
  }, []);

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

  const handleRecordingComplete = useCallback((blob: Blob) => {
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
      showToast("Recording saved!");
    }, 100);
  }, []);

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
        setIsRendering(false);

        // Provide more helpful error message with recovery option
        const errorMessage = e instanceof Error ? e.message : 'Unknown error';
        const isSharedArrayBufferError = errorMessage.includes('SharedArrayBuffer') ||
          errorMessage.includes('COOP') || errorMessage.includes('COEP');

        if (isSharedArrayBufferError) {
          showToast("FFmpeg requires special browser headers. Use Quick Record instead.", 4000);
        } else {
          showToast(`Render failed: ${errorMessage.slice(0, 50)}...`, 4000);
        }

        // Re-open export modal so user can try Quick Record
        setTimeout(() => setShowExportModal(true), 500);
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

            {/* DEBUG: Player Data Check */}
            {process.env.NODE_ENV === 'development' && (
              <div className="text-xs text-slate-500 font-mono bg-slate-900 p-2 rounded border border-slate-700 mt-4">
                DEBUG: Player Data - Segments: {segments.length}, Clips: {videoFiles.length}, Playing: {isPlaying}, Time: {(currentTime || 0).toFixed(2)}/{(duration || 0).toFixed(2)}
              </div>
            )}

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

              {/* Segment Track Editor */}
              <div className="mt-3">
                <SegmentTrack
                  segments={segments}
                  videoClips={videoFiles}
                  duration={duration}
                  currentTime={currentTime}
                  onSegmentUpdate={handleSegmentUpdate}
                  onSeek={handleSeek}
                />
              </div>

              {/* DEBUG: Timeline Data Check */}
              {process.env.NODE_ENV === 'development' && (
                <div className="text-xs text-slate-500 font-mono bg-slate-900 p-2 rounded border border-slate-700 mt-2">
                  DEBUG: Timeline Data - Beats: {beats.length}, Duration: {(duration || 0).toFixed(2)}, Waveform: {waveformData.length} samples
                </div>
              )}
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