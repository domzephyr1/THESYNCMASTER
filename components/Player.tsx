import React, { useEffect, useRef, useState } from 'react';
import { BeatMarker, EnhancedSyncSegment, VideoClip, TransitionType } from '../types';
import { Play, Pause, SkipBack, Loader2, Disc } from 'lucide-react';

// Binary search for segment lookup - O(log n)
function findSegmentAtTime(segments: EnhancedSyncSegment[], time: number): EnhancedSyncSegment | null {
  if (segments.length === 0) return null;
  let left = 0, right = segments.length - 1;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const seg = segments[mid];
    if (time >= seg.startTime && time < seg.endTime) return seg;
    else if (time < seg.startTime) right = mid - 1;
    else left = mid + 1;
  }
  return null;
}

interface PlayerProps {
  audioUrl: string;
  videoClips: VideoClip[];
  beats: BeatMarker[];
  duration: number;
  segments: EnhancedSyncSegment[];
  bpm: number;
  onTimeUpdate: (time: number) => void;
  isPlaying: boolean;
  onPlayToggle: (playing: boolean) => void;
  seekTime: number | null;
  isRecording?: boolean;
  onRecordingComplete?: (blob: Blob) => void;
}

interface PoolSlot {
  clipIndex: number;
  ready: boolean;
}

const POOL_SIZE = 3;

const Player: React.FC<PlayerProps> = ({
  audioUrl, videoClips, beats, duration, segments, bpm,
  onTimeUpdate, isPlaying, onPlayToggle, seekTime,
  isRecording = false, onRecordingComplete
}) => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // CANVAS-BUFFERED RENDERING: Draw video to canvas instead of showing video elements
  const displayCanvasRef = useRef<HTMLCanvasElement>(null);
  const recordCanvasRef = useRef<HTMLCanvasElement>(null);

  // Video pool (hidden - only for decoding)
  const videoPoolRefs = useRef<(HTMLVideoElement | null)[]>([null, null, null]);
  const poolSlots = useRef<PoolSlot[]>([
    { clipIndex: -1, ready: false },
    { clipIndex: -1, ready: false },
    { clipIndex: -1, ready: false }
  ]);
  const activeSlotRef = useRef<number>(0);
  const prevSlotRef = useRef<number>(-1);

  // Recording
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // Animation
  const requestRef = useRef<number | null>(null);
  const playPromiseRef = useRef<Promise<void> | null>(null);

  const [displayClipIndex, setDisplayClipIndex] = useState<number>(0);
  const [isReady, setIsReady] = useState(false);

  // Find available pool slot
  const findAvailableSlot = (exclude: number[]): number => {
    for (let i = 0; i < POOL_SIZE; i++) {
      if (!exclude.includes(i)) return i;
    }
    return 0;
  };

  // Draw a single frame to the display canvas
  const drawFrameToCanvas = (video: HTMLVideoElement) => {
    const canvas = displayCanvasRef.current;
    const ctx = canvas?.getContext('2d', { alpha: false });
    if (ctx && canvas && video.readyState >= 2) {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    }
  };

  // Load clip into slot
  const loadClipIntoSlot = (slot: number, clipIndex: number, seekTo?: number, drawInitialFrame?: boolean) => {
    const video = videoPoolRefs.current[slot];
    const clip = videoClips[clipIndex];
    if (!video || !clip) return;

    if (poolSlots.current[slot].clipIndex !== clipIndex) {
      poolSlots.current[slot] = { clipIndex, ready: false };
      video.src = clip.url;

      const onReady = () => {
        poolSlots.current[slot].ready = true;
        if (seekTo !== undefined) video.currentTime = seekTo;
        // Draw initial frame to canvas if requested
        if (drawInitialFrame) {
          // Small delay to ensure frame is decoded after seek
          setTimeout(() => drawFrameToCanvas(video), 50);
        }
        video.removeEventListener('canplaythrough', onReady);
      };
      video.addEventListener('canplaythrough', onReady);
      video.load();
    } else if (seekTo !== undefined) {
      video.currentTime = seekTo;
      if (drawInitialFrame) {
        setTimeout(() => drawFrameToCanvas(video), 50);
      }
    }
  };

  // Initialize
  useEffect(() => {
    if (segments.length > 0 && videoClips.length > 0) {
      const firstClip = segments[0].videoIndex;

      // Setup canvas size first
      const canvas = displayCanvasRef.current;
      if (canvas) {
        canvas.width = 1280;
        canvas.height = 720;
      }

      // Load first clip and draw initial frame
      loadClipIntoSlot(0, firstClip, segments[0].clipStartTime, true);
      activeSlotRef.current = 0;
      setDisplayClipIndex(firstClip);

      setIsReady(true);
    }
  }, [segments, videoClips]);

  // Cleanup
  useEffect(() => {
    return () => {
      videoPoolRefs.current.forEach(v => {
        if (v) { v.pause(); v.src = ''; }
      });
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, []);

  // Recording logic
  useEffect(() => {
    if (isRecording) {
      chunksRef.current = [];
      const canvas = recordCanvasRef.current;
      const audio = audioRef.current;

      if (canvas && audio) {
        canvas.width = 1280;
        canvas.height = 720;

        const canvasStream = canvas.captureStream(30);
        let audioStream: MediaStream | null = null;
        if ((audio as any).captureStream) audioStream = (audio as any).captureStream();
        else if ((audio as any).mozCaptureStream) audioStream = (audio as any).mozCaptureStream();

        const tracks = [...canvasStream.getVideoTracks(), ...(audioStream ? audioStream.getAudioTracks() : [])];
        const combinedStream = new MediaStream(tracks);

        try {
          const recorder = new MediaRecorder(combinedStream, { mimeType: 'video/webm;codecs=vp9,opus' });
          recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
          recorder.onstop = () => {
            const blob = new Blob(chunksRef.current, { type: 'video/webm' });
            if (onRecordingComplete) onRecordingComplete(blob);
          };
          recorder.start();
          recorderRef.current = recorder;
        } catch (e) {
          console.error("Recording failed", e);
        }
      }
    } else if (recorderRef.current?.state !== 'inactive') {
      recorderRef.current?.stop();
    }
  }, [isRecording]);

  // MAIN PLAYBACK LOOP with Canvas Rendering
  useEffect(() => {
    const audio = audioRef.current;
    const displayCanvas = displayCanvasRef.current;
    const recordCanvas = recordCanvasRef.current;
    if (!audio || !displayCanvas) return;

    const displayCtx = displayCanvas.getContext('2d', { alpha: false });
    const recordCtx = recordCanvas?.getContext('2d', { alpha: false });

    const renderFrame = () => {
      const currentTime = audio.currentTime;
      onTimeUpdate(currentTime);

      if (segments.length === 0) {
        if (!audio.paused) requestRef.current = requestAnimationFrame(renderFrame);
        return;
      }

      const currentSegment = findSegmentAtTime(segments, currentTime);
      if (!currentSegment) {
        if (!audio.paused) requestRef.current = requestAnimationFrame(renderFrame);
        return;
      }

      const timeInSegment = currentTime - currentSegment.startTime;
      const activeSlot = activeSlotRef.current;
      const activeClipIndex = poolSlots.current[activeSlot]?.clipIndex ?? -1;
      const activeVideo = videoPoolRefs.current[activeSlot];

      // --- CUT DETECTION ---
      if (currentSegment.videoIndex !== activeClipIndex && activeClipIndex !== -1) {
        const newClipIndex = currentSegment.videoIndex;

        // Find or load the new clip
        let newSlot = poolSlots.current.findIndex(s => s.clipIndex === newClipIndex);
        if (newSlot === -1) {
          newSlot = findAvailableSlot([activeSlot, prevSlotRef.current]);
          loadClipIntoSlot(newSlot, newClipIndex, currentSegment.clipStartTime);
        }

        // Pause old video
        if (activeVideo) activeVideo.pause();

        // Start new video (only if ready to avoid stalling)
        const newVideo = videoPoolRefs.current[newSlot];
        if (newVideo) {
          newVideo.currentTime = currentSegment.clipStartTime;
          newVideo.playbackRate = currentSegment.playbackSpeed || 1.0;
          // Guard: only play if HAVE_FUTURE_DATA or better
          if (isPlaying && newVideo.readyState >= 3) {
            newVideo.play().catch(() => {});
          }
        }

        prevSlotRef.current = activeSlot;
        activeSlotRef.current = newSlot;
        setDisplayClipIndex(newClipIndex);

      } else if (activeVideo) {
        // --- SYNC ACTIVE VIDEO ---
        const clip = videoClips[activeClipIndex];
        if (clip) {
          const targetTime = currentSegment.clipStartTime + timeInSegment;
          const clampedTime = Math.min(targetTime, (clip.trimEnd || clip.duration) - 0.05);

          const drift = Math.abs(activeVideo.currentTime - clampedTime);
          if (drift > 0.1) activeVideo.currentTime = clampedTime;

          // Guard: only play if HAVE_FUTURE_DATA or better
          if (isPlaying && activeVideo.paused && !activeVideo.ended && activeVideo.readyState >= 3) {
            activeVideo.play().catch(() => {});
          }
        }
      }

      // --- DRAW TO CANVAS (eliminates DOM flicker) ---
      const videoToDraw = videoPoolRefs.current[activeSlotRef.current];
      if (displayCtx && videoToDraw && videoToDraw.readyState >= 2) {
        displayCtx.drawImage(videoToDraw, 0, 0, displayCanvas.width, displayCanvas.height);

        // Also draw to record canvas if recording
        if (recordCtx && recordCanvas) {
          recordCtx.drawImage(videoToDraw, 0, 0, recordCanvas.width, recordCanvas.height);
        }
      }

      // --- PREDICTIVE PRELOAD (2 beats / 1.2s ahead) ---
      const segIdx = segments.findIndex(s => currentTime >= s.startTime && currentTime < s.endTime);
      if (segIdx >= 0 && segIdx < segments.length - 1) {
        const nextSeg = segments[segIdx + 1];
        const timeUntilCut = nextSeg.startTime - currentTime;
        const preloadWindow = bpm > 0 ? (120 / bpm) : 1.2; // ~2 beats

        if (timeUntilCut < preloadWindow && timeUntilCut > 0) {
          const nextClipIdx = nextSeg.videoIndex;
          const alreadyLoaded = poolSlots.current.some(s => s.clipIndex === nextClipIdx);

          if (!alreadyLoaded && nextClipIdx !== activeClipIndex) {
            const preloadSlot = findAvailableSlot([activeSlotRef.current, prevSlotRef.current]);
            loadClipIntoSlot(preloadSlot, nextClipIdx, nextSeg.clipStartTime);
          }
        }
      }

      if (!audio.paused) {
        requestRef.current = requestAnimationFrame(renderFrame);
      }
    };

    if (isPlaying) {
      playPromiseRef.current = audio.play().catch(() => {});
      const activeVideo = videoPoolRefs.current[activeSlotRef.current];
      // Guard: only play if HAVE_FUTURE_DATA or better
      if (activeVideo && activeVideo.readyState >= 3) {
        activeVideo.play().catch(() => {});
      }
      requestRef.current = requestAnimationFrame(renderFrame);
    } else {
      if (playPromiseRef.current) {
        playPromiseRef.current.then(() => audio.pause()).catch(() => audio.pause());
        playPromiseRef.current = null;
      } else {
        audio.pause();
      }
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
      videoPoolRefs.current.forEach(v => v?.pause());
    }

    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [isPlaying, segments, videoClips, bpm]);

  // Handle seek
  useEffect(() => {
    if (seekTime !== null && audioRef.current) {
      audioRef.current.currentTime = seekTime;
      onTimeUpdate(seekTime);

      const targetSeg = findSegmentAtTime(segments, seekTime);
      if (targetSeg) {
        const newClipIdx = targetSeg.videoIndex;
        const timeInSeg = seekTime - targetSeg.startTime;
        const clip = videoClips[newClipIdx];
        const targetTime = Math.min(targetSeg.clipStartTime + timeInSeg, (clip?.trimEnd || 999) - 0.05);

        // Pause current
        const currentVideo = videoPoolRefs.current[activeSlotRef.current];
        if (currentVideo) currentVideo.pause();

        // Find or load target
        let targetSlot = poolSlots.current.findIndex(s => s.clipIndex === newClipIdx);
        if (targetSlot === -1) {
          targetSlot = findAvailableSlot([]);
          loadClipIntoSlot(targetSlot, newClipIdx, targetTime, true);
        } else {
          const targetVideo = videoPoolRefs.current[targetSlot];
          if (targetVideo) {
            targetVideo.currentTime = targetTime;
            // Draw frame after seek settles
            setTimeout(() => drawFrameToCanvas(targetVideo), 50);
          }
        }

        activeSlotRef.current = targetSlot;
        prevSlotRef.current = -1;
        setDisplayClipIndex(newClipIdx);
      }
    }
  }, [seekTime, segments, videoClips]);

  if (!isReady && videoClips.length > 0) {
    return (
      <div className="flex items-center justify-center h-64 bg-black rounded-lg border border-slate-800">
        <Loader2 className="w-8 h-8 text-cyan-500 animate-spin" />
        <span className="ml-2 text-slate-400 font-mono">Loading...</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col space-y-4" ref={containerRef}>
      <div className="relative w-full aspect-video bg-black rounded-lg overflow-hidden border border-slate-700 shadow-2xl">
        <audio ref={audioRef} src={audioUrl} onEnded={() => onPlayToggle(false)} crossOrigin="anonymous" />

        {/* DISPLAY CANVAS - This is what users see (no DOM flicker) */}
        <canvas
          ref={displayCanvasRef}
          className="absolute top-0 left-0 w-full h-full object-contain"
          style={{ backgroundColor: '#000' }}
        />

        {/* Hidden record canvas */}
        <canvas ref={recordCanvasRef} className="hidden" />

        {/* Hidden video pool - only for decoding, never shown */}
        <div className="hidden">
          {[0, 1, 2].map((slot) => (
            <video
              key={`pool-${slot}`}
              ref={(el) => { videoPoolRefs.current[slot] = el; }}
              muted
              playsInline
              preload="auto"
              crossOrigin="anonymous"
            />
          ))}
        </div>

        {isRecording && (
          <div className="absolute top-4 right-4 flex items-center bg-red-500/90 text-white px-3 py-1 rounded-full animate-pulse z-50">
            <Disc className="w-4 h-4 mr-2" />
            <span className="text-xs font-bold font-mono">REC</span>
          </div>
        )}

        {!isRecording && (
          <div
            className="absolute inset-0 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity bg-black/40 z-30 cursor-pointer"
            onClick={() => onPlayToggle(!isPlaying)}
          >
            <button className="p-4 rounded-full bg-cyan-500/20 text-cyan-400 border border-cyan-500 hover:bg-cyan-500 hover:text-black transition-all">
              {isPlaying ? <Pause className="w-8 h-8" /> : <Play className="w-8 h-8" />}
            </button>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between px-4 py-3 bg-slate-900 rounded-lg border border-slate-800">
        <div className="flex items-center space-x-4">
          <button
            onClick={() => {
              if (audioRef.current) audioRef.current.currentTime = 0;
              onPlayToggle(false);
              onTimeUpdate(0);
            }}
            disabled={isRecording}
            className="text-slate-400 hover:text-white transition-colors disabled:opacity-50"
          >
            <SkipBack className="w-5 h-5" />
          </button>
          <div className="font-mono text-sm text-cyan-400">
            <span className="text-slate-100">{segments.length}</span> CUTS
            {bpm > 0 && <span className="ml-2 text-xs text-slate-500">({bpm} BPM)</span>}
          </div>
        </div>
        <div className="flex items-center space-x-2 text-xs font-mono">
          <span className="bg-slate-800 px-2 py-0.5 rounded text-slate-300">CLIP {displayClipIndex + 1}</span>
          <span className="text-green-400">CANVAS</span>
        </div>
      </div>
    </div>
  );
};

export default Player;
