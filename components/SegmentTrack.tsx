import React, { useState, useRef, useCallback } from 'react';
import { EnhancedSyncSegment, VideoClip, TransitionType } from '../types';
import { Film, Sparkles, ArrowRightLeft, GripVertical, ChevronLeft, ChevronRight, Palette } from 'lucide-react';

// Filter types matching the segment filter property
type FilterType = 'none' | 'bw' | 'contrast' | 'cyber' | 'saturate' | 'warm';

const FILTER_ICONS: Record<FilterType, string> = {
  'none': '🚫',
  'bw': '⬛',
  'contrast': '◐',
  'cyber': '💠',
  'saturate': '🌈',
  'warm': '🔥',
};

const FILTER_LABELS: Record<FilterType, string> = {
  'none': 'No Filter',
  'bw': 'Black & White',
  'contrast': 'High Contrast',
  'cyber': 'Cyber/Glitch',
  'saturate': 'Saturated',
  'warm': 'Warm Tones',
};

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

const getClipBorderColor = (index: number): string => {
  const colors = [
    'border-cyan-400', 'border-purple-400', 'border-pink-400', 'border-orange-400',
    'border-green-400', 'border-blue-400', 'border-red-400', 'border-yellow-400',
    'border-teal-400', 'border-indigo-400', 'border-rose-400', 'border-amber-400',
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
  const [showFilterPicker, setShowFilterPicker] = useState(false);
  const [resizing, setResizing] = useState<{ index: number; edge: 'start' | 'end' } | null>(null);
  const [hoveredSegment, setHoveredSegment] = useState<number | null>(null);
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
      setShowFilterPicker(false);
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

  // Handle filter change
  const handleFilterChange = (filter: FilterType) => {
    if (selectedSegment !== null) {
      onSegmentUpdate(selectedSegment, { filter });
      setShowFilterPicker(false);
    }
  };

  // Quick duration adjustments
  const adjustDuration = (amount: number) => {
    if (selectedSegment === null) return;
    const segment = segments[selectedSegment];
    if (!segment) return;

    const newEndTime = Math.max(segment.startTime + 0.1, segment.endTime + amount);
    const nextSegment = segments[selectedSegment + 1];

    // Don't go past the next segment or duration
    const maxEndTime = nextSegment ? nextSegment.endTime - 0.1 : duration;
    const clampedEndTime = Math.min(newEndTime, maxEndTime);

    onSegmentUpdate(selectedSegment, {
      endTime: clampedEndTime,
      duration: clampedEndTime - segment.startTime
    });

    // Adjust next segment if exists
    if (nextSegment) {
      onSegmentUpdate(selectedSegment + 1, {
        startTime: clampedEndTime,
        duration: nextSegment.endTime - clampedEndTime
      });
    }
  };

  // Handle resize start
  const handleResizeStart = (index: number, edge: 'start' | 'end', e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    setResizing({ index, edge });
    setSelectedSegment(index);
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

    const minDuration = 0.15; // Minimum segment duration

    if (resizing.edge === 'start') {
      const minTime = prevSegment ? prevSegment.startTime + minDuration : 0;
      const maxTime = segment.endTime - minDuration;
      const clampedTime = Math.max(minTime, Math.min(newTime, maxTime));

      if (!isFinite(clampedTime)) return;

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
      const minTime = segment.startTime + minDuration;
      const maxTime = nextSegment ? nextSegment.endTime - minDuration : duration;
      const clampedTime = Math.max(minTime, Math.min(newTime, maxTime));

      if (!isFinite(clampedTime)) return;

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
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
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
            Segment Editor
          </span>
          <span>No segments</span>
        </div>
        <div className="h-20 bg-slate-900 rounded-lg border border-slate-700 flex items-center justify-center text-slate-600 text-sm">
          Generate sync to see segments
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs text-slate-400">
        <span className="flex items-center gap-1">
          <Film className="w-3 h-3" />
          Segment Editor
        </span>
        <span className="text-slate-500">{segments.length} segments | Click to edit, drag edges to resize</span>
      </div>

      {/* Main Track - Taller for easier interaction */}
      <div
        ref={trackRef}
        className={`relative h-20 bg-slate-900 rounded-lg border overflow-hidden cursor-pointer transition-colors ${
          resizing ? 'border-cyan-500 bg-slate-800' : 'border-slate-700'
        }`}
        onClick={handleTrackClick}
      >
        {/* Segments */}
        {segments.map((segment, index) => {
          if (!segment || !isFinite(segment.startTime) || !isFinite(segment.endTime)) {
            return null;
          }

          const left = getPositionPercent(segment.startTime);
          const width = getPositionPercent(segment.endTime) - left;

          if (!isFinite(left) || !isFinite(width) || width <= 0) {
            return null;
          }

          const isSelected = selectedSegment === index;
          const isHovered = hoveredSegment === index;
          const isResizingThis = resizing?.index === index;
          const clipColor = getClipColor(segment.videoIndex ?? 0);
          const borderColor = getClipBorderColor(segment.videoIndex ?? 0);

          return (
            <div
              key={index}
              className={`absolute top-1 bottom-1 flex items-center justify-center text-[10px] font-mono text-white overflow-hidden transition-all rounded-sm
                ${clipColor}
                ${isSelected ? `ring-2 ring-white ring-offset-1 ring-offset-slate-900 z-20 brightness-110` : ''}
                ${isHovered && !isSelected ? 'brightness-125 z-10' : ''}
                ${isResizingThis ? 'opacity-80' : ''}
                ${segment.isDropSegment ? 'animate-pulse' : ''}
              `}
              style={{ left: `${left}%`, width: `${width}%`, minWidth: '8px' }}
              onClick={(e) => handleSegmentClick(index, e)}
              onMouseEnter={() => setHoveredSegment(index)}
              onMouseLeave={() => setHoveredSegment(null)}
              title={`Clip ${(segment.videoIndex ?? 0) + 1} | ${TRANSITION_LABELS[segment.transition] || 'Cut'} | ${(segment.duration ?? 0).toFixed(2)}s`}
            >
              {/* Left resize handle - larger and more visible */}
              <div
                className={`absolute left-0 top-0 bottom-0 w-3 cursor-ew-resize z-20 flex items-center justify-center transition-all
                  ${isHovered || isSelected ? 'bg-white/30' : 'bg-white/0 hover:bg-white/20'}`}
                onMouseDown={(e) => handleResizeStart(index, 'start', e)}
              >
                {(isHovered || isSelected) && width > 5 && (
                  <GripVertical className="w-2 h-4 text-white/70" />
                )}
              </div>

              {/* Right resize handle - larger and more visible */}
              <div
                className={`absolute right-0 top-0 bottom-0 w-3 cursor-ew-resize z-20 flex items-center justify-center transition-all
                  ${isHovered || isSelected ? 'bg-white/30' : 'bg-white/0 hover:bg-white/20'}`}
                onMouseDown={(e) => handleResizeStart(index, 'end', e)}
              >
                {(isHovered || isSelected) && width > 5 && (
                  <GripVertical className="w-2 h-4 text-white/70" />
                )}
              </div>

              {/* Segment content */}
              <div className="flex flex-col items-center pointer-events-none px-4">
                {width > 4 && (
                  <span className="font-bold text-white/90">
                    {segment.videoIndex + 1}
                  </span>
                )}
                {width > 8 && (
                  <span className="text-[8px] text-white/60">
                    {(segment.duration ?? 0).toFixed(1)}s
                  </span>
                )}
              </div>

              {/* Transition indicator */}
              {index > 0 && segment.transition !== TransitionType.CUT && (
                <div className="absolute -left-1.5 top-1/2 -translate-y-1/2 text-sm z-30 drop-shadow-lg">
                  {TRANSITION_ICONS[segment.transition]}
                </div>
              )}

              {/* Hero indicator */}
              {segment.isHeroSegment && (
                <Sparkles className="absolute top-1 right-1 w-3 h-3 text-yellow-300" />
              )}
            </div>
          );
        })}

        {/* Playhead */}
        <div
          className="absolute top-0 bottom-0 w-0.5 bg-white z-30 pointer-events-none shadow-[0_0_10px_rgba(255,255,255,0.9)]"
          style={{ left: `${playheadPos}%` }}
        >
          <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-white rounded-full" />
        </div>
      </div>

      {/* Edit Panel - More prominent */}
      {selectedSegment !== null && segments[selectedSegment] && (
        <div className="bg-slate-800/90 backdrop-blur rounded-lg p-4 border border-cyan-500/50 space-y-4 animate-fade-in shadow-lg">
          <div className="flex items-center justify-between">
            <span className="text-sm font-bold text-white">
              Editing Segment {selectedSegment + 1}
              <span className="ml-2 text-slate-400 font-normal">
                ({(segments[selectedSegment]?.duration ?? 0).toFixed(2)}s)
              </span>
            </span>
            <button
              onClick={() => setSelectedSegment(null)}
              className="text-slate-400 hover:text-white text-sm px-2 py-1 rounded hover:bg-slate-700"
            >
              ✕ Close
            </button>
          </div>

          <div className="grid grid-cols-4 gap-2">
            {/* Change Clip */}
            <div>
              <button
                onClick={() => { setShowClipPicker(!showClipPicker); setShowTransitionPicker(false); setShowFilterPicker(false); }}
                className={`w-full flex items-center justify-center gap-1 px-2 py-2.5 rounded text-sm font-medium transition-colors
                  ${showClipPicker ? 'bg-cyan-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600 hover:text-white'}`}
              >
                <Film className="w-4 h-4" />
                Clip
              </button>

              {showClipPicker && (
                <div className="mt-2 max-h-40 overflow-y-auto bg-slate-900 rounded border border-slate-600 p-1 shadow-xl absolute z-50 left-0 right-0 mx-4">
                  {videoClips.map((clip, idx) => (
                    <button
                      key={clip.id}
                      onClick={() => handleClipChange(idx)}
                      className={`w-full text-left px-2 py-1.5 text-xs rounded transition-colors flex items-center
                        ${idx === segments[selectedSegment]?.videoIndex
                          ? 'bg-cyan-600 text-white'
                          : 'text-slate-300 hover:bg-slate-700'}`}
                    >
                      <span className={`inline-block w-3 h-3 rounded mr-2 ${getClipColor(idx)}`} />
                      <span className="font-bold mr-1">{idx + 1}:</span>
                      <span className="truncate">{clip.name.slice(0, 18)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Change Transition */}
            <div>
              <button
                onClick={() => { setShowTransitionPicker(!showTransitionPicker); setShowClipPicker(false); setShowFilterPicker(false); }}
                className={`w-full flex items-center justify-center gap-1 px-2 py-2.5 rounded text-sm font-medium transition-colors
                  ${showTransitionPicker ? 'bg-purple-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600 hover:text-white'}`}
              >
                <ArrowRightLeft className="w-4 h-4" />
                Trans
              </button>

              {showTransitionPicker && (
                <div className="mt-2 bg-slate-900 rounded border border-slate-600 p-1 shadow-xl absolute z-50">
                  {Object.values(TransitionType).map((t) => (
                    <button
                      key={t}
                      onClick={() => handleTransitionChange(t)}
                      className={`w-full text-left px-2 py-1.5 text-xs rounded transition-colors flex items-center gap-2
                        ${t === segments[selectedSegment]?.transition
                          ? 'bg-purple-600 text-white'
                          : 'text-slate-300 hover:bg-slate-700'}`}
                    >
                      <span className="text-sm">{TRANSITION_ICONS[t]}</span>
                      {TRANSITION_LABELS[t]}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Change Filter */}
            <div>
              <button
                onClick={() => { setShowFilterPicker(!showFilterPicker); setShowClipPicker(false); setShowTransitionPicker(false); }}
                className={`w-full flex items-center justify-center gap-1 px-2 py-2.5 rounded text-sm font-medium transition-colors
                  ${showFilterPicker ? 'bg-amber-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600 hover:text-white'}`}
              >
                <Palette className="w-4 h-4" />
                Filter
              </button>

              {showFilterPicker && (
                <div className="mt-2 bg-slate-900 rounded border border-slate-600 p-1 shadow-xl absolute z-50">
                  {(Object.keys(FILTER_LABELS) as FilterType[]).map((f) => (
                    <button
                      key={f}
                      onClick={() => handleFilterChange(f)}
                      className={`w-full text-left px-2 py-1.5 text-xs rounded transition-colors flex items-center gap-2
                        ${f === segments[selectedSegment]?.filter
                          ? 'bg-amber-600 text-white'
                          : 'text-slate-300 hover:bg-slate-700'}`}
                    >
                      <span className="text-sm">{FILTER_ICONS[f]}</span>
                      {FILTER_LABELS[f]}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Quick Duration Adjust */}
            <div>
              <div className="flex gap-1">
                <button
                  onClick={() => adjustDuration(-0.1)}
                  className="flex-1 flex items-center justify-center px-1 py-2.5 rounded text-xs font-medium bg-slate-700 text-slate-300 hover:bg-slate-600 hover:text-white transition-colors"
                  title="Shorten by 0.1s"
                >
                  <ChevronLeft className="w-3 h-3" />
                  0.1
                </button>
                <button
                  onClick={() => adjustDuration(0.1)}
                  className="flex-1 flex items-center justify-center px-1 py-2.5 rounded text-xs font-medium bg-slate-700 text-slate-300 hover:bg-slate-600 hover:text-white transition-colors"
                  title="Lengthen by 0.1s"
                >
                  0.1
                  <ChevronRight className="w-3 h-3" />
                </button>
              </div>
            </div>
          </div>

          {/* Segment Info */}
          <div className="text-xs text-slate-500 font-mono flex flex-wrap gap-4 pt-2 border-t border-slate-700">
            <span>Start: <span className="text-slate-300">{(segments[selectedSegment]?.startTime ?? 0).toFixed(2)}s</span></span>
            <span>End: <span className="text-slate-300">{(segments[selectedSegment]?.endTime ?? 0).toFixed(2)}s</span></span>
            <span>Duration: <span className="text-cyan-400">{(segments[selectedSegment]?.duration ?? 0).toFixed(2)}s</span></span>
            <span>Filter: <span className="text-amber-400">{FILTER_LABELS[(segments[selectedSegment]?.filter as FilterType) || 'none']}</span></span>
          </div>
        </div>
      )}
    </div>
  );
};

export default SegmentTrack;
