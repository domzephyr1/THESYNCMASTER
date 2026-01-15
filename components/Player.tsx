import React, { useEffect, useRef, useState } from 'react';
import { BeatMarker, EnhancedSyncSegment, VideoClip, TransitionType } from '../types';
import { Play, Pause, SkipBack, Loader2, Disc, Zap, Maximize2, MoveHorizontal, Scissors } from 'lucide-react';

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
  const [activeClipIndex, setActiveClipIndex] = useState<number>(0);
  const [prevClipIndex, setPrevClipIndex] = useState<number>(-1); // For crossfades
  const [isReady, setIsReady] = useState(false);

  // Initialize
  useEffect(() => {
    if (segments.length > 0 && videoClips.length > 0) {
        setIsReady(true);
    }
  }, [segments, videoClips]);

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

      if (segments.length > 0) {
        const currentSegment = segments.find(
          seg => currentTime >= seg.startTime && currentTime < seg.endTime
        );
        
        if (currentSegment) {
          const timeInSegment = currentTime - currentSegment.startTime;
          
          // --- CUT EVENT ---
          if (currentSegment.videoIndex !== activeClipIndex) {
            setPrevClipIndex(activeClipIndex);
            setActiveClipIndex(currentSegment.videoIndex);
            
            // Init Transition Effects
            if (currentSegment.transition === TransitionType.ZOOM) fxState.current.zoom = 1.15;
            if (currentSegment.transition === TransitionType.GLITCH) fxState.current.glitch = 10; // Frames

            // Prepare New Video
            const videoEl = videoRefs.current[currentSegment.videoIndex];
            if (videoEl) {
              videoEl.currentTime = currentSegment.clipStartTime + timeInSegment;
              fxState.current.filter = currentSegment.filter;
              if (isPlaying) videoEl.play().catch(e => { if(e.name!=='AbortError') console.warn(e)});
            }
            
            // Pause others (except previous if crossfading)
            videoClips.forEach((_, idx) => {
                if (idx !== currentSegment.videoIndex && idx !== currentSegment.prevVideoIndex) {
                    const el = videoRefs.current[idx];
                    if (el) el.pause();
                }
            });

          } else {
             // --- DURING SEGMENT RENDER ---
             const activeVideo = videoRefs.current[activeClipIndex];
             const prevVideo = videoRefs.current[prevClipIndex];
             
             // 1. Sync Active Video
             const clipData = videoClips[activeClipIndex];
             if (activeVideo && clipData) {
                 const targetVideoTime = currentSegment.clipStartTime + timeInSegment;
                 const drift = Math.abs(activeVideo.currentTime - targetVideoTime);
                 
                 // Handle Looping if segment is longer than clip source
                 const sourceDuration = clipData.trimEnd - clipData.trimStart;
                 let loopAdjustedTime = targetVideoTime;
                 if (targetVideoTime >= clipData.trimEnd) {
                    loopAdjustedTime = clipData.trimStart + ((targetVideoTime - clipData.trimStart) % sourceDuration);
                    if (Math.abs(activeVideo.currentTime - loopAdjustedTime) > 0.5) {
                        activeVideo.currentTime = loopAdjustedTime;
                    }
                 } else {
                    // Standard Sync
                    if (drift > 0.4) activeVideo.currentTime = targetVideoTime;
                 }
                 
                 if (isPlaying && activeVideo.paused) activeVideo.play().catch(()=>{});

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

                 // Apply CSS
                 activeVideo.style.transform = `scale(${scale}) translateX(${translateX}px)`;
                 activeVideo.style.opacity = opacity.toString();
                 activeVideo.style.zIndex = '10';
                 
                 let cssFilter = '';
                 if (currentFilter === 'bw') cssFilter = 'grayscale(100%)';
                 else if (currentFilter === 'contrast') cssFilter = 'contrast(130%) brightness(110%)';
                 else if (currentFilter === 'cyber') cssFilter = 'hue-rotate(180deg) saturate(120%)';
                 
                 if (fxState.current.glitch > 0) cssFilter += ` blur(${Math.random()*2}px)`;
                 
                 activeVideo.style.filter = cssFilter;
             }
          }
        }
      }
      
      // --- CANVAS RENDER ---
      const activeVideo = videoRefs.current[activeClipIndex];
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
           if (prevClipIndex !== -1 && prevClipIndex !== activeClipIndex) {
               const prevVideo = videoRefs.current[prevClipIndex];
               const currentSeg = segments.find(s => currentTime >= s.startTime && currentTime < s.endTime);
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
      audio.play().catch(e => console.error("Audio play failed", e));
      const currentVideo = videoRefs.current[activeClipIndex];
      if (currentVideo) currentVideo.play().catch(() => {});
      requestRef.current = requestAnimationFrame(animate);
    } else {
      audio.pause();
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
      videoRefs.current.forEach(v => v && v.pause());
    }

    return () => {
        if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [isPlaying, segments, activeClipIndex, videoClips]); 

  // 4. Handle External Seek
  useEffect(() => {
    if (seekTime !== null && audioRef.current) {
      audioRef.current.currentTime = seekTime;
      onTimeUpdate(seekTime); 
      
      const targetSegment = segments.find(
        seg => seekTime >= seg.startTime && seekTime < seg.endTime
      );
      if (targetSegment) {
         setActiveClipIndex(targetSegment.videoIndex);
         setPrevClipIndex(-1);
         fxState.current.flash = 0;
         fxState.current.zoom = 1;
         fxState.current.glitch = 0;
         
         const videoEl = videoRefs.current[targetSegment.videoIndex];
         const clipData = videoClips[targetSegment.videoIndex];
         
         if(videoEl && clipData) {
             const timeInSegment = seekTime - targetSegment.startTime;
             let targetTime = targetSegment.clipStartTime + timeInSegment;
             const sourceDuration = clipData.trimEnd - clipData.trimStart;
             if (targetTime > clipData.trimEnd) {
                 targetTime = clipData.trimStart + ((targetTime - clipData.trimEnd) % sourceDuration);
             }
             videoEl.currentTime = targetTime;
         }
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
      {/* Viewport */}
      <div className="relative w-full aspect-video bg-black rounded-lg overflow-hidden border border-slate-700 shadow-2xl">
        <audio ref={audioRef} src={audioUrl} onEnded={() => onPlayToggle(false)} crossOrigin="anonymous" />
        <canvas ref={canvasRef} className="hidden" />

        {videoClips.map((clip, idx) => (
          <video
            key={clip.id}
            ref={(el) => { videoRefs.current[idx] = el; }}
            src={clip.url}
            className={`absolute top-0 left-0 w-full h-full object-contain will-change-transform`}
            style={{ 
                opacity: idx === activeClipIndex ? 1 : 0,
                zIndex: idx === activeClipIndex ? 10 : 0
            }}
            muted
            playsInline
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
             {segments[0] && (() => {
                 const current = segments.find(s => s.videoIndex === activeClipIndex);
                 if (!current) return null;
                 return (
                     <>
                        <div className="flex items-center space-x-2 text-slate-400">
                            {current.transition === TransitionType.CUT && <Scissors className="w-3 h-3 text-slate-500" />}
                            {current.transition === TransitionType.CROSSFADE && (
                                <span className="flex items-center text-yellow-400"><MoveHorizontal className="w-3 h-3 mr-1" /> FADE</span>
                            )}
                            {current.transition === TransitionType.ZOOM && (
                                <span className="flex items-center text-cyan-400"><Maximize2 className="w-3 h-3 mr-1" /> ZOOM</span>
                            )}
                            {current.transition === TransitionType.GLITCH && (
                                <span className="flex items-center text-red-400"><Zap className="w-3 h-3 mr-1" /> GLITCH</span>
                            )}
                        </div>
                        {current.filter !== 'none' && <span className="text-slate-300">| FX: {current.filter.toUpperCase()}</span>}
                     </>
                 )
             })()}
             <span className="ml-2 bg-slate-800 px-2 py-0.5 rounded text-slate-300">CLIP {activeClipIndex + 1}</span>
        </div>
      </div>
    </div>
  );
};

export default Player;