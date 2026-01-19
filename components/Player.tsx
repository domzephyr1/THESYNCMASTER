import React, { useEffect, useRef, useState } from 'react';
import { BeatMarker, EnhancedSyncSegment, VideoClip, TransitionType } from '../types';
import { Play, Pause, SkipBack, Loader2, Disc } from 'lucide-react';

// Binary search for finding segment at a given time - O(log n) instead of O(n)
function findSegmentAtTime(segments: EnhancedSyncSegment[], time: number): EnhancedSyncSegment | null {
  if (segments.length === 0) return null;

  let left = 0;
  let right = segments.length - 1;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    const seg = segments[mid];

    if (time >= seg.startTime && time < seg.endTime) {
      return seg;
    } else if (time < seg.startTime) {
      right = mid - 1;
    } else {
      left = mid + 1;
    }
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
  seekTime: number | null; // Signal to seek
  isRecording?: boolean;
  onRecordingComplete?: (blob: Blob) => void;
}

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
  
  // Recording Refs
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  
  // Visual FX Refs
  const fxState = useRef({
    flash: 0,
    zoom: 1.0, 
    filter: 'none',
    glitch: 0
  });
  
  const videoRefs = useRef<(HTMLVideoElement | null)[]>([]);
  // Use refs for animation state to avoid re-renders during playback
  const activeClipRef = useRef<number>(0);
  const prevClipRef = useRef<number>(-1);
  const [displayClipIndex, setDisplayClipIndex] = useState<number>(0); // For UI only
  const [isReady, setIsReady] = useState(false);

  // Predictive double-buffering state
  const nextSegmentIndexRef = useRef<number>(-1);
  const preloadedClipIndexRef = useRef<number>(-1);
  const preloadingRef = useRef<boolean>(false);

  // Store segments in ref so animation loop can access latest without restarting
  const segmentsRef = useRef<EnhancedSyncSegment[]>(segments);
  const videoClipsRef = useRef<VideoClip[]>(videoClips);

  // Update refs when props change (doesn't restart animation loop)
  useEffect(() => {
    segmentsRef.current = segments;
  }, [segments]);

  useEffect(() => {
    videoClipsRef.current = videoClips;
  }, [videoClips]);

  // Track previous segments to detect changes
  const prevSegmentsRef = useRef<EnhancedSyncSegment[]>([]);
  const segmentsVersionRef = useRef(0);

  // Initialize and preload videos for smooth playback
  useEffect(() => {
    if (segments.length > 0 && videoClips.length > 0) {
      // Check if segments actually changed (not just a re-render)
      const segmentsChanged = prevSegmentsRef.current.length !== segments.length ||
        (segments.length > 0 && prevSegmentsRef.current.length > 0 &&
          segments[0].startTime !== prevSegmentsRef.current[0]?.startTime);

      if (segmentsChanged) {
        console.log('🔄 Segments changed, resetting player state');
        segmentsVersionRef.current++;

        // Reset preload state
        preloadedClipIndexRef.current = -1;
        preloadingRef.current = false;
        nextSegmentIndexRef.current = -1;

        // Reset to first segment's clip
        activeClipRef.current = segments[0].videoIndex;
        prevClipRef.current = -1;

        // Reset all video states
        videoRefs.current.forEach((video, idx) => {
          if (video) {
            video.style.opacity = idx === segments[0].videoIndex ? '1' : '0';
            video.style.zIndex = idx === segments[0].videoIndex ? '10' : '0';
            video.style.transform = 'scale(1)';
            video.style.filter = '';
          }
        });

        // Set the first video to the correct position
        const firstVideo = videoRefs.current[segments[0].videoIndex];
        if (firstVideo) {
          firstVideo.currentTime = segments[0].clipStartTime;
        }

        setDisplayClipIndex(segments[0].videoIndex);
      }

      prevSegmentsRef.current = segments;

      // Preload first 3 unique video clips used in segments for smooth start
      const preloadVideos = async () => {
        const uniqueIndices = [...new Set(segments.slice(0, 10).map(s => s.videoIndex))].slice(0, 3);

        await Promise.all(
          uniqueIndices.map(idx => {
            return new Promise<void>((resolve) => {
              const video = videoRefs.current[idx];
              if (video) {
                if (video.readyState >= 3) {
                  resolve();
                  return;
                }
                const onReady = () => {
                  video.removeEventListener('canplaythrough', onReady);
                  resolve();
                };
                video.addEventListener('canplaythrough', onReady);
                video.load();
                // Timeout fallback
                setTimeout(resolve, 2000);
              } else {
                resolve();
              }
            });
          })
        );

        setIsReady(true);
      };

      preloadVideos();
    }
  }, [segments, videoClips]);

  // Cleanup video elements on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      videoRefs.current.forEach(video => {
        if (video) {
          video.pause();
          video.src = '';
          video.load();
        }
      });
    };
  }, []);

  // 2. Recording Logic
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
          alert("Recording failed. Browser may not support this format.");
        }
      }
    } else {
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        recorderRef.current.stop();
      }
    }
  }, [isRecording]);

  // Track play promise to prevent race conditions
  const playPromiseRef = useRef<Promise<void> | null>(null);

  // 3. Playback Loop (Visual Engine)
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

      // Zoom return to 1.0 (slow ease out)
      if (fxState.current.zoom > 1.0) fxState.current.zoom = 1.0 + (fxState.current.zoom - 1.0) * 0.95;
      if (fxState.current.zoom < 1.001) fxState.current.zoom = 1.0;

      // Use refs to get latest segments/clips without restarting animation loop
      const currentSegments = segmentsRef.current;
      const currentVideoClips = videoClipsRef.current;

      if (currentSegments.length > 0) {
        // Use binary search for O(log n) lookup instead of O(n) .find()
        const currentSegment = findSegmentAtTime(currentSegments, currentTime);

        if (currentSegment) {
          const timeInSegment = currentTime - currentSegment.startTime;
          const activeClipIndex = activeClipRef.current;
          const prevClipIndex = prevClipRef.current;

          // --- CUT EVENT ---
          if (currentSegment.videoIndex !== activeClipIndex) {
            const newClipIndex = currentSegment.videoIndex;

            console.log('🎬 CUT EVENT:', {
              time: (currentTime || 0).toFixed(2),
              fromClip: activeClipIndex,
              toClip: newClipIndex,
              segmentStart: (currentSegment?.startTime || 0).toFixed(2),
              timeInSegment: (timeInSegment || 0).toFixed(2),
              wasPreloaded: preloadedClipIndexRef.current === newClipIndex
            });

            // Update refs (no re-render)
            prevClipRef.current = activeClipIndex;
            activeClipRef.current = newClipIndex;

            // Hide previous video immediately
            const prevVideo = videoRefs.current[activeClipIndex];
            if (prevVideo) {
              prevVideo.style.opacity = '0';
              prevVideo.style.zIndex = '0';
              prevVideo.pause();
            }

            // Show and play new video
            const videoEl = videoRefs.current[newClipIndex];
            if (videoEl) {
              // Check if this clip was preloaded to the correct position
              const wasPreloaded = preloadedClipIndexRef.current === newClipIndex;

              // ALWAYS set position precisely at cut - this is critical for sync
              const targetStartTime = currentSegment.clipStartTime;
              videoEl.currentTime = targetStartTime;

              // Set playback speed BEFORE playing
              videoEl.playbackRate = currentSegment.playbackSpeed || 1.0;

              // Make visible
              videoEl.style.opacity = '1';
              videoEl.style.zIndex = '10';
              videoEl.style.transform = 'scale(1)';
              videoEl.style.filter = '';

              // Start playing immediately - don't wait
              if (isPlaying) {
                videoEl.play().catch(() => {});
              }

              // Reset preload state
              preloadedClipIndexRef.current = -1;
            }

            // Update UI state less frequently (every cut is fine)
            setDisplayClipIndex(newClipIndex);

          } else {
             // --- DURING SEGMENT RENDER ---
             const activeVideo = videoRefs.current[activeClipIndex];
             const prevVideo = videoRefs.current[prevClipIndex];

             // 1. Sync Active Video - LET IT PLAY NATURALLY, only correct major drift
             const clipData = currentVideoClips[activeClipIndex];
             if (activeVideo && clipData) {
                 const targetVideoTime = currentSegment.clipStartTime + timeInSegment;
                 const drift = Math.abs(activeVideo.currentTime - targetVideoTime);

                 // Handle Looping ONLY - if segment needs to loop back
                 const sourceDuration = clipData.trimEnd - clipData.trimStart;
                 if (targetVideoTime >= clipData.trimEnd) {
                    const loopAdjustedTime = clipData.trimStart + ((targetVideoTime - clipData.trimStart) % sourceDuration);
                    if (Math.abs(activeVideo.currentTime - loopAdjustedTime) > 0.15) {
                        activeVideo.currentTime = loopAdjustedTime;
                    }
                 }
                 // REMOVED: Constant drift correction - this was causing stuttering
                 // Only correct if SEVERELY out of sync (> 300ms) - indicates a real problem
                 else if (drift > 0.3) {
                    console.log('⚡ Major drift correction:', drift.toFixed(3));
                    activeVideo.currentTime = targetVideoTime;
                 }

                 // Ensure video is playing
                 if (isPlaying && activeVideo.paused) activeVideo.play().catch(()=>{});

                 // Apply speed ramping (set once per segment, not every frame)
                 const targetSpeed = currentSegment.playbackSpeed || 1.0;
                 if (Math.abs(activeVideo.playbackRate - targetSpeed) > 0.01) {
                   activeVideo.playbackRate = targetSpeed;
                 }

                 // Apply Transforms
                 let scale = fxState.current.zoom;
                 let translateX = 0;
                 let opacity = 1;
                 let currentFilter = currentSegment.filter;

                 // Glitch Effect
                 if (fxState.current.glitch > 0) {
                     translateX = (Math.random() - 0.5) * 20;
                     scale = 1.05 + Math.random() * 0.05;
                     if (Math.random() > 0.5) currentFilter = 'cyber';
                 }

                 // Crossfade Logic
                 if (currentSegment.transition === TransitionType.CROSSFADE) {
                     const fadeDuration = 0.5; 
                     if (timeInSegment < fadeDuration) {
                         opacity = timeInSegment / fadeDuration; // 0 -> 1
                         
                         // Keep Previous Video Playing & Fading Out
                         if (prevVideo && prevClipIndex !== -1) {
                             prevVideo.style.opacity = (1 - opacity).toString();
                             prevVideo.style.zIndex = '5';
                             if (prevVideo.paused && isPlaying) prevVideo.play().catch(()=>{});
                         }
                     } else {
                         if (prevVideo) {
                             prevVideo.style.opacity = '0';
                             prevVideo.pause();
                         }
                     }
                 } else {
                     if (prevVideo && prevClipIndex !== -1 && prevClipIndex !== activeClipIndex) {
                        prevVideo.style.opacity = '0';
                        prevVideo.pause();
                     }
                 }

                 // Apply CSS - use translate3d for GPU acceleration
                 activeVideo.style.transform = `scale(${scale}) translate3d(${translateX}px, 0, 0)`;
                 activeVideo.style.opacity = opacity.toString();
                 activeVideo.style.zIndex = '10';
                 
                 let cssFilter = '';
                 if (currentFilter === 'bw') cssFilter = 'grayscale(100%)';
                 else if (currentFilter === 'contrast') cssFilter = 'contrast(130%) brightness(110%)';
                 else if (currentFilter === 'cyber') cssFilter = 'hue-rotate(180deg) saturate(120%)';
                 
                 if (fxState.current.glitch > 0) cssFilter += ` blur(${Math.random()*2}px)`;
                 
                 activeVideo.style.filter = cssFilter;
             }

             // --- PREDICTIVE PRELOADING (Look-ahead) ---
             // Find next segment
             const currentSegmentIndex = currentSegments.findIndex(seg =>
               currentTime >= seg.startTime && currentTime < seg.endTime
             );

             if (currentSegmentIndex >= 0 && currentSegmentIndex < currentSegments.length - 1) {
               const nextSegment = currentSegments[currentSegmentIndex + 1];
               const timeUntilNextCut = nextSegment.startTime - currentTime;

               // Start preloading 500ms before cut
               if (timeUntilNextCut < 0.5 && timeUntilNextCut > 0) {
                 const nextClipIndex = nextSegment.videoIndex;

                 // Only preload if not already preloaded and not currently preloading
                 if (nextClipIndex !== preloadedClipIndexRef.current &&
                     nextClipIndex !== activeClipIndex &&
                     !preloadingRef.current) {

                   preloadingRef.current = true;
                   const nextVideo = videoRefs.current[nextClipIndex];

                   if (nextVideo) {
                     // Seek to the start position for next segment
                     const targetTime = nextSegment.clipStartTime;

                     // Check if we need to seek
                     if (Math.abs(nextVideo.currentTime - targetTime) > 0.1) {
                       nextVideo.currentTime = targetTime;

                       // Wait for buffer to be ready
                       const onSeeked = () => {
                         preloadedClipIndexRef.current = nextClipIndex;
                         nextSegmentIndexRef.current = currentSegmentIndex + 1;
                         preloadingRef.current = false;
                         nextVideo.removeEventListener('seeked', onSeeked);
                         nextVideo.removeEventListener('canplay', onSeeked);
                       };

                       nextVideo.addEventListener('seeked', onSeeked, { once: true });
                       nextVideo.addEventListener('canplay', onSeeked, { once: true });

                       // Timeout fallback in case events don't fire
                       setTimeout(() => {
                         if (preloadingRef.current) {
                           preloadedClipIndexRef.current = nextClipIndex;
                           preloadingRef.current = false;
                         }
                       }, 300);
                     } else {
                       // Already at correct position
                       preloadedClipIndexRef.current = nextClipIndex;
                       preloadingRef.current = false;
                     }
                   }
                 }
               }
             }
          }
        }
      }

      // --- CANVAS RENDER ---
      const activeVideo = videoRefs.current[activeClipRef.current];
      const canvas = canvasRef.current;
      if (canvas && activeVideo) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
           const w = canvas.width || 1280;
           const h = canvas.height || 720;
           if (canvas.width !== activeVideo.videoWidth && activeVideo.videoWidth > 0) {
              canvas.width = activeVideo.videoWidth;
              canvas.height = activeVideo.videoHeight;
           }
           ctx.drawImage(activeVideo, 0, 0, w, h);
           // Simple draw for recorder
           if (prevClipRef.current !== -1 && prevClipRef.current !== activeClipRef.current) {
               const prevVideo = videoRefs.current[prevClipRef.current];
               const currentSeg = findSegmentAtTime(currentSegments, currentTime);
               if (prevVideo && currentSeg?.transition === TransitionType.CROSSFADE) {
                    const time = currentTime - currentSeg.startTime;
                    if (time < 0.5) {
                        ctx.globalAlpha = 1 - (time/0.5);
                        ctx.drawImage(prevVideo, 0, 0, w, h);
                        ctx.globalAlpha = 1.0;
                    }
               }
           }
        }
      }

      // --- DOM FX ---
      const flashOverlay = containerRef.current?.querySelector('.flash-overlay') as HTMLElement;
      if (flashOverlay) flashOverlay.style.opacity = fxState.current.flash.toString();

      if (!audio.paused) {
        requestRef.current = requestAnimationFrame(animate);
      }
    };

    if (isPlaying) {
      playPromiseRef.current = audio.play().catch(e => console.error("Audio play failed", e));
      const currentVideo = videoRefs.current[activeClipRef.current];
      if (currentVideo) {
        currentVideo.style.opacity = '1';
        currentVideo.play().catch(() => {});
      }
      requestRef.current = requestAnimationFrame(animate);
    } else {
      // IMMEDIATELY stop animation loop first
      if (requestRef.current) {
        cancelAnimationFrame(requestRef.current);
        requestRef.current = null;
      }

      // Pause all videos immediately
      videoRefs.current.forEach(v => {
        if (v) {
          v.pause();
        }
      });

      // Then handle audio pause (with promise safety)
      if (playPromiseRef.current) {
        playPromiseRef.current.then(() => {
          audio.pause();
        }).catch(() => {
          audio.pause();
        });
        playPromiseRef.current = null;
      } else {
        audio.pause();
      }
    }

    return () => {
        if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  // Only restart animation loop when isPlaying changes - segments/clips use refs
  }, [isPlaying]); 

  // 4. Handle External Seek
  useEffect(() => {
    if (seekTime !== null && audioRef.current) {
      audioRef.current.currentTime = seekTime;
      onTimeUpdate(seekTime);

      // Use binary search for segment lookup (use ref for latest segments)
      const targetSegment = findSegmentAtTime(segmentsRef.current, seekTime);
      if (targetSegment) {
         // Hide current video
         const currentVideo = videoRefs.current[activeClipRef.current];
         if (currentVideo) {
           currentVideo.style.opacity = '0';
           currentVideo.pause();
         }

         // Update refs
         activeClipRef.current = targetSegment.videoIndex;
         prevClipRef.current = -1;
         setDisplayClipIndex(targetSegment.videoIndex);

         fxState.current.flash = 0;
         fxState.current.zoom = 1;
         fxState.current.glitch = 0;

         const videoEl = videoRefs.current[targetSegment.videoIndex];
         const clipData = videoClipsRef.current[targetSegment.videoIndex];

         if(videoEl && clipData) {
             const timeInSegment = seekTime - targetSegment.startTime;
             let targetTime = targetSegment.clipStartTime + timeInSegment;
             const sourceDuration = clipData.trimEnd - clipData.trimStart;
             if (targetTime > clipData.trimEnd) {
                 targetTime = clipData.trimStart + ((targetTime - clipData.trimStart) % sourceDuration);
             }
             videoEl.currentTime = targetTime;
             videoEl.style.opacity = '1';
             videoEl.style.zIndex = '10';
         }
      }
    }
  // Only react to seekTime changes - segments/clips use refs
  }, [seekTime]);

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
      {/* Viewport */}
      <div className="relative w-full aspect-video bg-black rounded-lg overflow-hidden border border-slate-700 shadow-2xl">
        <audio ref={audioRef} src={audioUrl} onEnded={() => onPlayToggle(false)} crossOrigin="anonymous" />
        <canvas ref={canvasRef} className="hidden" />

        {videoClips.map((clip, idx) => (
          <video
            key={clip.id}
            ref={(el) => { videoRefs.current[idx] = el; }}
            src={clip.url}
            className="absolute top-0 left-0 w-full h-full object-contain"
            style={{
                opacity: (segments.length > 0 && idx === segments[0].videoIndex) ? 1 : 0,
                zIndex: (segments.length > 0 && idx === segments[0].videoIndex) ? 10 : 0,
                transition: 'none', // No CSS transitions - we control via JS
                willChange: 'transform, opacity, filter' // Hint to browser for GPU acceleration
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
          <div className="absolute inset-0 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity bg-black/40 backdrop-blur-sm z-30 group cursor-pointer" onClick={() => onPlayToggle(!isPlaying)}>
            <button className="p-4 rounded-full bg-cyan-500/20 text-cyan-400 border border-cyan-500 hover:bg-cyan-500 hover:text-black transition-all transform hover:scale-110 shadow-[0_0_20px_rgba(6,182,212,0.4)]">
              {isPlaying ? <Pause className="w-8 h-8 fill-current" /> : <Play className="w-8 h-8 fill-current" />}
            </button>
          </div>
        )}
      </div>

      {/* Control Bar */}
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
             <span className="text-slate-100">{segments.length}</span> CINEMATIC CUTS
             {bpm > 0 && <span className="ml-2 text-xs text-slate-500">({bpm} BPM)</span>}
           </div>
        </div>
        <div className="flex items-center space-x-4 text-xs font-mono text-slate-500">
             <span className="bg-slate-800 px-2 py-0.5 rounded text-slate-300">CLIP {displayClipIndex + 1}</span>
        </div>
      </div>
    </div>
  );
};

export default Player;