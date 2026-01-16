import React, { useRef, useState, useEffect, useCallback } from 'react';
import { VideoClip } from '../types';
import { X, Check, Play, Pause, Scissors } from 'lucide-react';

interface VideoTrimmerProps {
  clip: VideoClip;
  onSave: (id: string, start: number, end: number) => void;
  onClose: () => void;
}

const formatTime = (seconds: number) => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 10);
  return `${m}:${s.toString().padStart(2, '0')}.${ms}`;
};

const VideoTrimmer: React.FC<VideoTrimmerProps> = ({ clip, onSave, onClose }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  
  // Trimming State
  const [start, setStart] = useState(clip.trimStart);
  const [end, setEnd] = useState(clip.trimEnd > 0 ? clip.trimEnd : clip.duration);
  
  // Dragging state for slider handles
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<'start' | 'end' | null>(null);

  // Use refs to avoid stale closures in event listeners
  const startRef = useRef(start);
  const endRef = useRef(end);
  startRef.current = start;
  endRef.current = end;

  useEffect(() => {
    // Ensure end is valid if passed as 0 or greater than duration
    if (clip.duration && (end === 0 || end > clip.duration)) {
      setEnd(clip.duration);
    }
  }, [clip.duration, end]);

  const handlePlayToggle = () => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
      } else {
        // If we are at the end of the trim, restart from trim start
        if (videoRef.current.currentTime >= end) {
          videoRef.current.currentTime = start;
        }
        videoRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const onTimeUpdate = () => {
    if (videoRef.current) {
      const time = videoRef.current.currentTime;
      setCurrentTime(time);
      
      // Loop within trim bounds
      if (time >= end) {
        videoRef.current.pause();
        videoRef.current.currentTime = start;
        setIsPlaying(false);
      }
    }
  };

  // Slider Logic
  const handleMouseDown = (type: 'start' | 'end') => {
    setDragging(type);
  };

  // Use useCallback with refs to avoid recreating listeners
  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!trackRef.current) return;

    const rect = trackRef.current.getBoundingClientRect();
    const offsetX = e.clientX - rect.left;
    const percent = Math.max(0, Math.min(1, offsetX / rect.width));
    const time = percent * clip.duration;

    // Use refs for current values to avoid stale closure
    const currentStart = startRef.current;
    const currentEnd = endRef.current;

    if (dragging === 'start') {
      const newStart = Math.min(time, currentEnd - 0.5);
      setStart(newStart);
      if (videoRef.current) videoRef.current.currentTime = newStart;
    } else if (dragging === 'end') {
      const newEnd = Math.max(time, currentStart + 0.5);
      setEnd(newEnd);
      if (videoRef.current) videoRef.current.currentTime = newEnd;
    }
  }, [clip.duration, dragging]);

  const handleMouseUp = useCallback(() => {
    setDragging(null);
  }, []);

  useEffect(() => {
    if (dragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [dragging, handleMouseMove, handleMouseUp]);

  const save = () => {
    onSave(clip.id, start, end);
    onClose();
  };

  const leftPercent = (start / clip.duration) * 100;
  const widthPercent = ((end - start) / clip.duration) * 100;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-md p-4">
      <div className="w-full max-w-4xl bg-slate-900 border border-slate-700 rounded-xl overflow-hidden shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800">
          <div className="flex items-center space-x-2">
            <Scissors className="w-5 h-5 text-cyan-400" />
            <h2 className="text-lg font-bold text-white">Trim Clip: <span className="text-slate-400 font-normal">{clip.name}</span></h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors">
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Video Area */}
        <div className="relative flex-1 bg-black flex items-center justify-center min-h-[400px]">
          <video
            ref={videoRef}
            src={clip.url}
            className="max-h-[50vh] w-full object-contain"
            onTimeUpdate={onTimeUpdate}
            onEnded={() => setIsPlaying(false)}
          />
          {!isPlaying && (
            <button 
              onClick={handlePlayToggle}
              className="absolute p-4 rounded-full bg-cyan-500/20 text-cyan-400 border border-cyan-500 hover:bg-cyan-500 hover:text-black transition-all transform hover:scale-110"
            >
              <Play className="w-8 h-8 fill-current ml-1" />
            </button>
          )}
          {isPlaying && (
            <div 
              className="absolute inset-0 z-10" 
              onClick={handlePlayToggle} 
            />
          )}
        </div>

        {/* Controls */}
        <div className="px-8 py-8 bg-slate-900 space-y-6">
          
          <div className="flex justify-between text-xs font-mono text-slate-400 mb-1">
             <span>Start: <span className="text-cyan-400">{formatTime(start)}</span></span>
             <span>Duration: <span className="text-white">{formatTime(end - start)}</span></span>
             <span>End: <span className="text-cyan-400">{formatTime(end)}</span></span>
          </div>

          {/* Timeline Slider */}
          <div 
            ref={trackRef}
            className="relative h-12 bg-slate-800 rounded select-none cursor-pointer"
          >
            {/* Base track */}
            <div className="absolute inset-x-0 top-1/2 h-2 -mt-1 bg-slate-700 rounded-full" />
            
            {/* Active Range */}
            <div 
              className="absolute top-1/2 h-2 -mt-1 bg-cyan-500 rounded-full opacity-50"
              style={{ left: `${leftPercent}%`, width: `${widthPercent}%` }}
            />

            {/* Start Handle */}
            <div 
              className="absolute top-0 bottom-0 w-4 bg-cyan-400 rounded-l cursor-ew-resize shadow-[0_0_10px_rgba(6,182,212,0.5)] flex items-center justify-center z-10 hover:bg-white transition-colors"
              style={{ left: `${leftPercent}%` }}
              onMouseDown={() => handleMouseDown('start')}
            >
               <div className="w-1 h-4 bg-slate-900 rounded-full opacity-50" />
            </div>

            {/* End Handle */}
            <div 
              className="absolute top-0 bottom-0 w-4 bg-cyan-400 rounded-r cursor-ew-resize shadow-[0_0_10px_rgba(6,182,212,0.5)] flex items-center justify-center z-10 hover:bg-white transition-colors"
              style={{ left: `calc(${leftPercent + widthPercent}% - 16px)` }}
              onMouseDown={() => handleMouseDown('end')}
            >
               <div className="w-1 h-4 bg-slate-900 rounded-full opacity-50" />
            </div>
            
            {/* Playhead Marker */}
            <div 
              className="absolute top-0 bottom-0 w-0.5 bg-yellow-500 pointer-events-none z-0"
              style={{ left: `${(currentTime / clip.duration) * 100}%` }}
            />
          </div>

          <div className="flex justify-end pt-4">
             <button 
               onClick={save}
               className="flex items-center px-6 py-3 bg-cyan-600 hover:bg-cyan-500 text-white font-bold rounded shadow-lg transition-all"
             >
               <Check className="w-5 h-5 mr-2" />
               Confirm Trim
             </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default VideoTrimmer;
