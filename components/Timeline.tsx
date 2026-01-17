import React, { useEffect, useRef } from 'react';
import { BeatMarker } from '../types';

interface TimelineProps {
  waveformData: number[];
  beats: BeatMarker[];
  duration: number;
  currentTime: number;
  className?: string;
  onSeek?: (time: number) => void;
  onBeatToggle?: (time: number) => void;
  onBeatPreview?: (beatTime: number) => void;
}

const Timeline: React.FC<TimelineProps> = ({
  waveformData,
  beats,
  duration,
  currentTime,
  className = "",
  onSeek,
  onBeatToggle,
  onBeatPreview
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    console.log('🎯 TIMELINE: useEffect triggered');
    console.log('🎯 TIMELINE: beats prop:', beats);
    console.log('🎯 TIMELINE: beats.length:', beats.length);
    console.log('🎯 TIMELINE: beats[0]:', beats[0]);
    console.log('🎯 TIMELINE: beats[0]?.time:', beats[0]?.time);
    console.log('🎯 TIMELINE: typeof beats[0]?.time:', typeof beats[0]?.time);

    const canvas = canvasRef.current;
    if (!canvas) {
      console.log('🎯 TIMELINE: No canvas ref');
      return;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      console.log('🎯 TIMELINE: No canvas context');
      return;
    }

    const width = canvas.width;
    const height = canvas.height;

    // DEBUG: Log beat rendering data
    console.log('🎯 TIMELINE RENDER:', `beatsCount=${beats.length}, duration=${(duration || 0).toFixed(2)}, width=${width}, hasWaveform=${waveformData.length > 0}`);
    if (beats.length > 0) {
      console.log('🎯 TIMELINE BEATS:', beats.slice(0, 3).map((b, i) => `beat[${i}]: time=${b?.time}, intensity=${b?.intensity}, isNaN=${isNaN(b?.time)}`).join(' | '));
    }

    // Clear
    ctx.clearRect(0, 0, width, height);

    // Draw Background Grid
    ctx.fillStyle = '#0f172a'; // Slate 900
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = '#1e293b'; // Slate 800
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    // Draw Waveform
    if (waveformData.length > 0) {
      ctx.beginPath();
      const barWidth = width / waveformData.length;
      const centerY = height / 2;

      ctx.fillStyle = '#06b6d4'; // Cyan 500

      waveformData.forEach((val, index) => {
        const x = index * barWidth;
        const barHeight = val * (height * 0.8); // 80% height max

        // Mirrored bars
        ctx.fillRect(x, centerY - barHeight / 2, barWidth - 1, barHeight);
      });
    }

    // Draw Beats - ALWAYS ON TOP with high visibility
    if (beats.length > 0) {
      const effectiveDuration = duration > 0 ? duration : 1;

      console.log('🎯 DRAWING BEATS:', `effectiveDuration=${effectiveDuration.toFixed(2)}, beatsToDraw=${beats.length}, canvasSize=${width}x${height}`);

      // Draw beat markers with GLOW effect for visibility
      ctx.save();
      ctx.shadowColor = '#fbbf24';
      ctx.shadowBlur = 8;

      ctx.strokeStyle = '#fbbf24'; // Amber 400 - very bright
      ctx.lineWidth = 2;

      beats.forEach((beat) => {
        const x = Math.round((beat.time / effectiveDuration) * width);
        if (x >= 0 && x <= width) {
          // Draw vertical line
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
          ctx.stroke();
        }
      });

      // Draw marker heads on top (no shadow for cleaner look)
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#fbbf24'; // Amber 400

      beats.forEach((beat) => {
        const x = Math.round((beat.time / effectiveDuration) * width);
        if (x >= 0 && x <= width) {
          ctx.beginPath();
          ctx.arc(x, 8, 5, 0, Math.PI * 2);
          ctx.fill();
        }
      });

      ctx.restore();
    }

  }, [waveformData, beats, duration]);

  // Handle Playhead separation to keep animation smooth
  // We overlay a div for the playhead instead of redrawing canvas every frame
  
  // Find nearest beat to a time (within threshold)
  const findNearestBeat = (time: number, threshold: number = 0.3): BeatMarker | null => {
    let nearest: BeatMarker | null = null;
    let minDistance = threshold;

    for (const beat of beats) {
      const distance = Math.abs(beat.time - time);
      if (distance < minDistance) {
        minDistance = distance;
        nearest = beat;
      }
    }
    return nearest;
  };

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percentage = x / rect.width;
    const time = percentage * duration;

    // Shift + Click to Toggle Beat
    if (e.shiftKey && onBeatToggle) {
        onBeatToggle(time);
        return;
    }

    // Alt + Click to Preview Beat (find nearest beat)
    if (e.altKey && onBeatPreview) {
        const nearestBeat = findNearestBeat(time);
        if (nearestBeat) {
            onBeatPreview(nearestBeat.time);
        }
        return;
    }

    // Normal Click to Seek
    if (onSeek) {
        onSeek(time);
    }
  };

  const playheadPos = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="space-y-1">
      <div 
        ref={containerRef}
        className={`relative h-24 w-full bg-slate-900 rounded-lg overflow-hidden border border-slate-700 cursor-pointer group ${className}`}
        onClick={handleClick}
        title="Click to Seek. Shift+Click to Add/Remove Beat. Alt+Click to Preview Beat."
      >
        <canvas 
          ref={canvasRef} 
          width={1000} 
          height={150} 
          className="w-full h-full block"
        />
        
        {/* Playhead */}
        <div 
          className="absolute top-0 bottom-0 w-0.5 bg-white z-10 shadow-[0_0_10px_rgba(255,255,255,0.8)] pointer-events-none transition-all duration-75 ease-linear"
          style={{ left: `${playheadPos}%` }}
        >
          <div className="absolute -top-1 -left-1.5 w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[8px] border-t-white"></div>
        </div>
      </div>
      <div className="flex justify-between px-1 text-[10px] text-slate-500 font-mono">
         <span>0:00</span>
         <span className="text-slate-600">SHIFT+CLICK Edit | ALT+CLICK Preview</span>
         <span>END</span>
      </div>
    </div>
  );
};

export default Timeline;