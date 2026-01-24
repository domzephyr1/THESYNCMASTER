import React, { useEffect, useRef, useState } from 'react';
import { BeatMarker, EnhancedSyncSegment, VideoClip, TransitionType } from '../types';
import { Play, Pause, SkipBack, Loader2, Disc } from 'lucide-react';

// Binary search for finding segment at a given time - O(log n)
function findSegmentAtTime(segments: EnhancedSyncSegment[], time: number): EnhancedSyncSegment | null {
  if (segments.length === 0) return null;
  let left = 0;
  let right = segments.length - 1;

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

// Video pool slot tracking
interface PoolSlot {
  clipIndex: number;
  ready: boolean;
}

const POOL_SIZE = 3; // Only 3 video elements instead of 50+

const Player: React.FC<PlayerProps> = ({
  audioUrl,
  videoClips,
  beats,
  duration,
  segments,
  bpm,
  onTimeUpdate,
  isPlaying,
  onPlayToggle,
  seekTime,
  isRecording = false,
  onRecordingComplete
}) => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef<number | null>(null);

  // VIDEO POOL: Only 3 video elements
  const videoPoolRefs = useRef<(HTMLVideoElement | null)[]>([null, null, null]);
  const poolSlots = useRef<PoolSlot[]>([
    { clipIndex: -1, ready: false },
    { clipIndex: -1, ready: false },
    { clipIndex: -1, ready: false }
  ]);
  const activeSlotRef = useRef<number>(0);
  const prevSlotRef = useRef<number>(-1);

  // Recording Refs
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // Visual FX
  const fxState = useRef({ flash: 0, zoom: 1.0, filter: 'none', glitch: 0 });

  const [displayClipIndex, setDisplayClipIndex] = useState<number>(0);
  const [isReady, setIsReady] = useState(false);
  const playPromiseRef = useRef<Promise<void> | null>(null);

  // Find an available pool slot (not currently active or previous)
  const findAvailableSlot = (excludeSlots: number[]): number => {
    for (let i = 0; i < POOL_SIZE; i++) {
      if (!excludeSlots.includes(i)) return i;
    }
    return 0; // Fallback
  };

  // Load a clip into a specific pool slot
  const loadClipIntoSlot = (slotIndex: number, clipIndex: number, seekTo?: number) => {
    const video = videoPoolRefs.current[slotIndex];
    const clip = videoClips[clipIndex];
    if (!video || !clip) return;

    // Only reload if different clip
    if (poolSlots.current[slotIndex].clipIndex !== clipIndex) {
      video.src = clip.url;
      poolSlots.current[slotIndex] = { clipIndex, ready: false };

      const onReady = () => {
        poolSlots.current[slotIndex].ready = true;
        if (seekTo !== undefined) video.currentTime = seekTo;
        video.removeEventListener('loadeddata', onReady);
      };
      video.addEventListener('loadeddata', onReady);
      video.load();
    } else if (seekTo !== undefined) {
      video.currentTime = seekTo;
    }
  };

  // Initialize first segment
  useEffect(() => {
    if (segments.length > 0 && videoClips.length > 0) {
      const firstClipIndex = segments[0].videoIndex;
      loadClipIntoSlot(0, firstClipIndex, segments[0].clipStartTime);
      activeSlotRef.current = 0;
      setDisplayClipIndex(firstClipIndex);
      setIsReady(true);
    }
  }, [segments, videoClips]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      videoPoolRefs.current.forEach(video => {
        if (video) {
          video.pause();
          video.src = '';
          video.load();
        }
      });
    };
  }, []);

  // Recording Logic
  useEffect(() => {
    if (isRecording) {
      chunksRef.current = [];
      const canvas = canvasRef.current;
      const audio = audioRef.current;

      if (canvas && audio) {
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
          console.error("MediaRecorder failed", e);
        }
      }
    } else {
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        recorderRef.current.stop();
      }
    }
  }, [isRecording]);

  // Main Playback Loop
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const animate = () => {
      if (!audio) return;
      const currentTime = audio.currentTime;
      onTimeUpdate(currentTime);

      // FX Decay
      if (fxState.current.flash > 0) fxState.current.flash *= 0.85;
      if (fxState.current.glitch > 0) fxState.current.glitch -= 1;
      if (fxState.current.zoom > 1.0) fxState.current.zoom = 1.0 + (fxState.current.zoom - 1.0) * 0.95;
      if (fxState.current.zoom < 1.001) fxState.current.zoom = 1.0;

      if (segments.length > 0) {
        const currentSegment = findSegmentAtTime(segments, currentTime);

        if (currentSegment) {
          const timeInSegment = currentTime - currentSegment.startTime;
          const activeSlot = activeSlotRef.current;
          const activeClipIndex = poolSlots.current[activeSlot].clipIndex;
          const activeVideo = videoPoolRefs.current[activeSlot];

          // --- CUT EVENT: Need different clip ---
          if (currentSegment.videoIndex !== activeClipIndex) {
            const newClipIndex = currentSegment.videoIndex;

            // Find slot with this clip already loaded, or get available slot
            let newSlot = poolSlots.current.findIndex(s => s.clipIndex === newClipIndex);
            if (newSlot === -1) {
              newSlot = findAvailableSlot([activeSlot, prevSlotRef.current]);
              loadClipIntoSlot(newSlot, newClipIndex, currentSegment.clipStartTime);
            }

            // Hide previous
            if (activeVideo) {
              activeVideo.style.opacity = '0';
              activeVideo.style.zIndex = '0';
              activeVideo.pause();
            }

            // Show new
            const newVideo = videoPoolRefs.current[newSlot];
            if (newVideo) {
              newVideo.currentTime = currentSegment.clipStartTime;
              newVideo.style.opacity = '1';
              newVideo.style.zIndex = '10';
              newVideo.playbackRate = currentSegment.playbackSpeed || 1.0;
              if (isPlaying) newVideo.play().catch(() => {});
            }

            prevSlotRef.current = activeSlot;
            activeSlotRef.current = newSlot;
            setDisplayClipIndex(newClipIndex);

          } else {
            // --- DURING SEGMENT: Sync video ---
            const clip = videoClips[activeClipIndex];
            if (activeVideo && clip) {
              const targetTime = currentSegment.clipStartTime + timeInSegment;
              let clampedTime = Math.min(targetTime, clip.trimEnd - 0.01);

              const drift = Math.abs(activeVideo.currentTime - clampedTime);
              if (drift > 0.15) activeVideo.currentTime = clampedTime;

              const videoEnded = activeVideo.ended || activeVideo.currentTime >= activeVideo.duration - 0.1;
              if (isPlaying && activeVideo.paused && !videoEnded) activeVideo.play().catch(() => {});

              // Apply transforms
              let scale = fxState.current.zoom;
              let translateX = fxState.current.glitch > 0 ? (Math.random() - 0.5) * 20 : 0;
              activeVideo.style.transform = `scale(${scale}) translate3d(${translateX}px, 0, 0)`;

              // Crossfade with previous
              if (currentSegment.transition === TransitionType.CROSSFADE && timeInSegment < 0.5) {
                const prevVideo = videoPoolRefs.current[prevSlotRef.current];
                if (prevVideo && prevSlotRef.current !== -1) {
                  const opacity = timeInSegment / 0.5;
                  activeVideo.style.opacity = opacity.toString();
                  prevVideo.style.opacity = (1 - opacity).toString();
                  prevVideo.style.zIndex = '5';
                  if (prevVideo.paused && isPlaying) prevVideo.play().catch(() => {});
                }
              }
            }

            // --- PREDICTIVE PRELOAD: Load next clip ---
            const segIdx = segments.findIndex(s => currentTime >= s.startTime && currentTime < s.endTime);
            if (segIdx >= 0 && segIdx < segments.length - 1) {
              const nextSeg = segments[segIdx + 1];
              const timeUntilCut = nextSeg.startTime - currentTime;

              if (timeUntilCut < 0.8 && timeUntilCut > 0) {
                const nextClipIndex = nextSeg.videoIndex;
                const alreadyLoaded = poolSlots.current.some(s => s.clipIndex === nextClipIndex);

                if (!alreadyLoaded && nextClipIndex !== activeClipIndex) {
                  const preloadSlot = findAvailableSlot([activeSlot, prevSlotRef.current]);
                  loadClipIntoSlot(preloadSlot, nextClipIndex, nextSeg.clipStartTime);
                }
              }
            }
          }
        }
      }

      // Canvas render for recording
      const activeVideo = videoPoolRefs.current[activeSlotRef.current];
      const canvas = canvasRef.current;
      if (canvas && activeVideo && activeVideo.readyState >= 2) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          if (canvas.width !== 1280) { canvas.width = 1280; canvas.height = 720; }
          ctx.drawImage(activeVideo, 0, 0, canvas.width, canvas.height);
        }
      }

      // Flash overlay
      const flashOverlay = containerRef.current?.querySelector('.flash-overlay') as HTMLElement;
      if (flashOverlay) flashOverlay.style.opacity = fxState.current.flash.toString();

      if (!audio.paused) requestRef.current = requestAnimationFrame(animate);
    };

    if (isPlaying) {
      playPromiseRef.current = audio.play().catch(() => {});
      const activeVideo = videoPoolRefs.current[activeSlotRef.current];
      if (activeVideo) {
        activeVideo.style.opacity = '1';
        activeVideo.play().catch(() => {});
      }
      requestRef.current = requestAnimationFrame(animate);
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

    return () => { if (requestRef.current) cancelAnimationFrame(requestRef.current); };
  }, [isPlaying, segments, videoClips]);

  // Handle External Seek
  useEffect(() => {
    if (seekTime !== null && audioRef.current) {
      audioRef.current.currentTime = seekTime;
      onTimeUpdate(seekTime);

      const targetSeg = findSegmentAtTime(segments, seekTime);
      if (targetSeg) {
        const newClipIndex = targetSeg.videoIndex;
        const timeInSeg = seekTime - targetSeg.startTime;
        const targetTime = Math.min(targetSeg.clipStartTime + timeInSeg, videoClips[newClipIndex]?.trimEnd - 0.01 || 999);

        // Hide current
        const currentVideo = videoPoolRefs.current[activeSlotRef.current];
        if (currentVideo) {
          currentVideo.style.opacity = '0';
          currentVideo.pause();
        }

        // Find or load target clip
        let targetSlot = poolSlots.current.findIndex(s => s.clipIndex === newClipIndex);
        if (targetSlot === -1) {
          targetSlot = findAvailableSlot([]);
          loadClipIntoSlot(targetSlot, newClipIndex, targetTime);
        }

        const targetVideo = videoPoolRefs.current[targetSlot];
        if (targetVideo) {
          targetVideo.currentTime = targetTime;
          targetVideo.style.opacity = '1';
          targetVideo.style.zIndex = '10';
        }

        activeSlotRef.current = targetSlot;
        prevSlotRef.current = -1;
        setDisplayClipIndex(newClipIndex);
      }
    }
  }, [seekTime, segments, videoClips]);

  if (!isReady && videoClips.length > 0) {
    return (
      <div className="flex items-center justify-center h-64 bg-black rounded-lg border border-slate-800">
        <Loader2 className="w-8 h-8 text-cyan-500 animate-spin" />
        <span className="ml-2 text-slate-400 font-mono">Loading Media...</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col space-y-4" ref={containerRef}>
      <div className="relative w-full aspect-video bg-black rounded-lg overflow-hidden border border-slate-700 shadow-2xl">
        <audio ref={audioRef} src={audioUrl} onEnded={() => onPlayToggle(false)} crossOrigin="anonymous" />
        <canvas ref={canvasRef} className="hidden" />

        {/* VIDEO POOL: Only 3 elements instead of 50+ */}
        {[0, 1, 2].map((slotIdx) => (
          <video
            key={`pool-${slotIdx}`}
            ref={(el) => { videoPoolRefs.current[slotIdx] = el; }}
            className="absolute top-0 left-0 w-full h-full object-contain"
            style={{
              opacity: slotIdx === 0 ? 1 : 0,
              zIndex: slotIdx === 0 ? 10 : 0,
              transition: 'none',
              willChange: 'transform, opacity'
            }}
            muted
            playsInline
            preload="auto"
            crossOrigin="anonymous"
          />
        ))}

        <div className="flash-overlay absolute inset-0 bg-white pointer-events-none z-20 opacity-0 mix-blend-overlay"></div>

        {isRecording && (
          <div className="absolute top-4 right-4 flex items-center bg-red-500/90 text-white px-3 py-1 rounded-full animate-pulse z-50">
            <Disc className="w-4 h-4 mr-2" />
            <span className="text-xs font-bold font-mono">RECORDING...</span>
          </div>
        )}

        {!isRecording && (
          <div className="absolute inset-0 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity bg-black/40 backdrop-blur-sm z-30 cursor-pointer" onClick={() => onPlayToggle(!isPlaying)}>
            <button className="p-4 rounded-full bg-cyan-500/20 text-cyan-400 border border-cyan-500 hover:bg-cyan-500 hover:text-black transition-all transform hover:scale-110 shadow-[0_0_20px_rgba(6,182,212,0.4)]">
              {isPlaying ? <Pause className="w-8 h-8 fill-current" /> : <Play className="w-8 h-8 fill-current" />}
            </button>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between px-4 py-3 bg-slate-900 rounded-lg border border-slate-800">
        <div className="flex items-center space-x-4">
          <button
            onClick={() => {
              if(audioRef.current) audioRef.current.currentTime = 0;
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
        <div className="flex items-center space-x-4 text-xs font-mono text-slate-500">
          <span className="bg-slate-800 px-2 py-0.5 rounded text-slate-300">CLIP {displayClipIndex + 1}</span>
          <span className="text-green-400">3-POOL</span>
        </div>
      </div>
    </div>
  );
};

export default Player;
