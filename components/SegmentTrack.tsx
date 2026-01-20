import React, { useState, useRef, useCallback } from 'react';
import { EnhancedSyncSegment, VideoClip, TransitionType } from '../types';
import { Film, Zap, Sparkles, ArrowRightLeft } from 'lucide-react';

interface SegmentTrackProps {
  segments: EnhancedSyncSegment[];
  videoClips: VideoClip[];
  duration: number;
  currentTime: number;
  onSegmentUpdate: (index: number, updates: Partial<EnhancedSyncSegment>) => void;
  onSeek?: (time: number) => void;
}

const TRANSITION_ICONS: Record<TransitionType, string> = {
  [TransitionType.CUT]: '✂️',
  [TransitionType.CROSSFADE]: '🌊',
  [TransitionType.ZOOM]: '🔍',
  [TransitionType.GLITCH]: '⚡',
  [TransitionType.WHIP]: '💨',
  [TransitionType.FLASH]: '💥',
  [TransitionType.IMPACT]: '🔥',
};

const TRANSITION_LABELS: Record<TransitionType, string> = {
  [TransitionType.CUT]: 'Cut',
  [TransitionType.CROSSFADE]: 'Crossfade',
  [TransitionType.ZOOM]: 'Zoom',
  [TransitionType.GLITCH]: 'Glitch',
  [TransitionType.WHIP]: 'Whip',
  [TransitionType.FLASH]: 'Flash',
  [TransitionType.IMPACT]: 'Impact',
};

// Generate distinct colors for clips
const getClipColor = (index: number): string => {
  const colors = [
    'bg-cyan-600', 'bg-purple-600', 'bg-pink-600', 'bg-orange-600',
    'bg-green-600', 'bg-blue-600', 'bg-red-600', 'bg-yellow-600',
    'bg-teal-600', 'bg-indigo-600', 'bg-rose-600', 'bg-amber-600',
  ];
  return colors[index % colors.length];
};

const SegmentTrack: React.FC<SegmentTrackProps> = ({
  segments,
  videoClips,
  duration,
  currentTime,
  onSegmentUpdate,
  onSeek,
}) => {
  const [selectedSegment, setSelectedSegment] = useState<number | null>(null);
  const [showClipPicker, setShowClipPicker] = useState(false);
  const [showTransitionPicker, setShowTransitionPicker] = useState(false);
  const [resizing, setResizing] = useState<{ index: number; edge: 'start' | 'end' } | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  // Calculate position percentage (guard against division by zero)
  const getPositionPercent = (time: number) => {
    if (!duration || !isFinite(duration) || duration <= 0) return 0;
    if (!isFinite(time)) return 0;
    return (time / duration) * 100;
  };

  // Handle segment click
  const handleSegmentClick = (index: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (selectedSegment === index) {
      setSelectedSegment(null);
      setShowClipPicker(false);
      setShowTransitionPicker(false);
    } else {
      setSelectedSegment(index);
      setShowClipPicker(false);
      setShowTransitionPicker(false);
    }
  };

  // Handle track click (seek)
  const handleTrackClick = (e: React.MouseEvent) => {
    if (!trackRef.current || resizing) return;
    if (!duration || !isFinite(duration) || duration <= 0) return;
    const rect = trackRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percent = x / rect.width;
    const time = percent * duration;
    if (isFinite(time) && onSeek) onSeek(time);
  };

  // Handle clip change
  const handleClipChange = (clipIndex: number) => {
    if (selectedSegment !== null) {
      onSegmentUpdate(selectedSegment, { videoIndex: clipIndex });
      setShowClipPicker(false);
    }
  };

  // Handle transition change
  const handleTransitionChange = (transition: TransitionType) => {
    if (selectedSegment !== null) {
      onSegmentUpdate(selectedSegment, { transition });
      setShowTransitionPicker(false);
    }
  };

  // Handle resize start
  const handleResizeStart = (index: number, edge: 'start' | 'end', e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setResizing({ index, edge });
  };

  // Handle resize move
  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!resizing || !trackRef.current) return;
    if (!duration || !isFinite(duration) || duration <= 0) return;

    const rect = trackRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
    const newTime = (x / rect.width) * duration;

    if (!isFinite(newTime)) return;

    const segment = segments[resizing.index];
    if (!segment) return;
    const prevSegment = segments[resizing.index - 1];
    const nextSegment = segments[resizing.index + 1];

    const minDuration = 0.2; // Minimum segment duration

    if (resizing.edge === 'start') {
      // Can't go before previous segment or make current segment too short
      const minTime = prevSegment ? prevSegment.startTime + minDuration : 0;
      const maxTime = segment.endTime - minDuration;
      const clampedTime = Math.max(minTime, Math.min(newTime, maxTime));

      // Guard against non-finite values
      if (!isFinite(clampedTime)) return;

      // Update current segment start and previous segment end
      onSegmentUpdate(resizing.index, {
        startTime: clampedTime,
        duration: segment.endTime - clampedTime
      });
      if (prevSegment) {
        onSegmentUpdate(resizing.index - 1, {
          endTime: clampedTime,
          duration: clampedTime - prevSegment.startTime
        });
      }
    } else {
      // Can't go past next segment or make current segment too short
      const minTime = segment.startTime + minDuration;
      const maxTime = nextSegment ? nextSegment.endTime - minDuration : duration;
      const clampedTime = Math.max(minTime, Math.min(newTime, maxTime));

      // Guard against non-finite values
      if (!isFinite(clampedTime)) return;

      // Update current segment end and next segment start
      onSegmentUpdate(resizing.index, {
        endTime: clampedTime,
        duration: clampedTime - segment.startTime
      });
      if (nextSegment) {
        onSegmentUpdate(resizing.index + 1, {
          startTime: clampedTime,
          duration: nextSegment.endTime - clampedTime
        });
      }
    }
  }, [resizing, segments, duration, onSegmentUpdate]);

  // Handle resize end
  const handleMouseUp = useCallback(() => {
    setResizing(null);
  }, []);

  // Add/remove mouse event listeners for resizing
  React.useEffect(() => {
    if (resizing) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [resizing, handleMouseMove, handleMouseUp]);

  const playheadPos = getPositionPercent(currentTime);

  // Early return if no valid data
  if (!segments || segments.length === 0 || !duration || !isFinite(duration) || duration <= 0) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs text-slate-400">
          <span className="flex items-center gap-1">
            <Film className="w-3 h-3" />
            Segment Track
          </span>
          <span>No segments</span>
        </div>
        <div className="h-16 bg-slate-900 rounded-lg border border-slate-700 flex items-center justify-center text-slate-600 text-sm">
          Generate sync to see segments
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-slate-400">
        <span className="flex items-center gap-1">
          <Film className="w-3 h-3" />
          Segment Track
        </span>
        <span>{segments.length} segments</span>
      </div>

      {/* Main Track */}
      <div
        ref={trackRef}
        className="relative h-16 bg-slate-900 rounded-lg border border-slate-700 overflow-hidden cursor-pointer"
        onClick={handleTrackClick}
      >
        {/* Segments */}
        {segments.map((segment, index) => {
          // Skip segments with invalid data
          if (!segment || !isFinite(segment.startTime) || !isFinite(segment.endTime)) {
            return null;
          }

          const left = getPositionPercent(segment.startTime);
          const width = getPositionPercent(segment.endTime) - left;

          // Skip if width is invalid
          if (!isFinite(left) || !isFinite(width) || width <= 0) {
            return null;
          }

          const isSelected = selectedSegment === index;
          const clipColor = getClipColor(segment.videoIndex ?? 0);

          return (
            <div
              key={index}
              className={`absolute top-1 bottom-1 flex items-center justify-center text-[9px] font-mono text-white overflow-hidden transition-all cursor-pointer group
                ${clipColor} ${isSelected ? 'ring-2 ring-white ring-offset-1 ring-offset-slate-900 z-20' : 'hover:brightness-110'}
                ${segment.isDropSegment ? 'animate-pulse' : ''}
              `}
              style={{ left: `${left}%`, width: `${width}%`, minWidth: '4px' }}
              onClick={(e) => handleSegmentClick(index, e)}
              title={`Clip ${(segment.videoIndex ?? 0) + 1} | ${TRANSITION_LABELS[segment.transition] || 'Cut'} | ${(segment.duration ?? 0).toFixed(2)}s`}
            >
              {/* Resize handles */}
              <div
                className="absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize bg-white/0 hover:bg-white/30 z-10"
                onMouseDown={(e) => handleResizeStart(index, 'start', e)}
              />
              <div
                className="absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize bg-white/0 hover:bg-white/30 z-10"
                onMouseDown={(e) => handleResizeStart(index, 'end', e)}
              />

              {/* Segment content */}
              {width > 3 && (
                <span className="truncate px-1 pointer-events-none">
                  {segment.videoIndex + 1}
                </span>
              )}

              {/* Transition indicator */}
              {index > 0 && segment.transition !== TransitionType.CUT && (
                <div className="absolute -left-1 top-1/2 -translate-y-1/2 text-[8px] z-30">
                  {TRANSITION_ICONS[segment.transition]}
                </div>
              )}

              {/* Hero/Drop indicators */}
              {segment.isHeroSegment && (
                <Sparkles className="absolute top-0.5 right-0.5 w-2 h-2 text-yellow-300" />
              )}
            </div>
          );
        })}

        {/* Playhead */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-white z-30 pointer-events-none shadow-[0_0_8px_rgba(255,255,255,0.8)]"
          style={{ left: `${playheadPos}%` }}
        />
      </div>

      {/* Edit Panel */}
      {selectedSegment !== null && segments[selectedSegment] && (
        <div className="bg-slate-800 rounded-lg p-3 border border-slate-700 space-y-3 animate-fade-in">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-slate-200">
              Edit Segment {selectedSegment + 1}
            </span>
            <button
              onClick={() => setSelectedSegment(null)}
              className="text-slate-400 hover:text-white text-xs"
            >
              ✕ Close
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            {/* Change Clip Button */}
            <div>
              <button
                onClick={() => { setShowClipPicker(!showClipPicker); setShowTransitionPicker(false); }}
                className={`w-full flex items-center justify-center gap-2 px-3 py-2 rounded text-sm transition-colors
                  ${showClipPicker ? 'bg-cyan-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}
              >
                <Film className="w-4 h-4" />
                Change Clip
              </button>

              {showClipPicker && (
                <div className="mt-2 max-h-32 overflow-y-auto bg-slate-900 rounded border border-slate-600 p-1">
                  {videoClips.map((clip, idx) => (
                    <button
                      key={clip.id}
                      onClick={() => handleClipChange(idx)}
                      className={`w-full text-left px-2 py-1 text-xs rounded transition-colors
                        ${idx === segments[selectedSegment]?.videoIndex
                          ? 'bg-cyan-600 text-white'
                          : 'text-slate-300 hover:bg-slate-700'}`}
                    >
                      <span className={`inline-block w-2 h-2 rounded-full mr-2 ${getClipColor(idx)}`} />
                      Clip {idx + 1}: {clip.name.slice(0, 20)}...
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Change Transition Button */}
            <div>
              <button
                onClick={() => { setShowTransitionPicker(!showTransitionPicker); setShowClipPicker(false); }}
                className={`w-full flex items-center justify-center gap-2 px-3 py-2 rounded text-sm transition-colors
                  ${showTransitionPicker ? 'bg-purple-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'}`}
              >
                <ArrowRightLeft className="w-4 h-4" />
                Transition
              </button>

              {showTransitionPicker && (
                <div className="mt-2 bg-slate-900 rounded border border-slate-600 p-1">
                  {Object.values(TransitionType).map((t) => (
                    <button
                      key={t}
                      onClick={() => handleTransitionChange(t)}
                      className={`w-full text-left px-2 py-1 text-xs rounded transition-colors flex items-center gap-2
                        ${t === segments[selectedSegment]?.transition
                          ? 'bg-purple-600 text-white'
                          : 'text-slate-300 hover:bg-slate-700'}`}
                    >
                      <span>{TRANSITION_ICONS[t]}</span>
                      {TRANSITION_LABELS[t]}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Segment Info */}
          <div className="text-[10px] text-slate-500 font-mono flex gap-4">
            <span>Start: {(segments[selectedSegment]?.startTime ?? 0).toFixed(2)}s</span>
            <span>End: {(segments[selectedSegment]?.endTime ?? 0).toFixed(2)}s</span>
            <span>Duration: {(segments[selectedSegment]?.duration ?? 0).toFixed(2)}s</span>
          </div>
        </div>
      )}

      {/* Instructions */}
      <div className="text-center text-[9px] text-slate-600">
        CLICK segment to edit | DRAG edges to resize
      </div>
    </div>
  );
};

export default SegmentTrack;
