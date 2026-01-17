import React, { useRef } from 'react';
import { VideoClip, EnhancedSyncSegment } from '../types';
import { SceneMarker } from '../services/sceneDetectionService';
import { Trash2, Scissors, GripVertical, Film, Shuffle, Sun, Contrast, SplitSquareHorizontal, Loader2, Scan } from 'lucide-react';

interface ClipManagerProps {
  clips: VideoClip[];
  segments?: EnhancedSyncSegment[];
  onReorder: (fromIndex: number, toIndex: number) => void;
  onRemove: (id: string) => void;
  onTrim: (clip: VideoClip) => void;
  onShuffle?: () => void;
  // Scene detection props
  clipScenes?: Record<string, SceneMarker[]>;
  detectingScenes?: string | null;
  onDetectScenes?: (clipId: string, clipUrl: string) => void;
  onAutoSplit?: (clipId: string) => void;
}

const ClipManager: React.FC<ClipManagerProps> = ({
  clips,
  segments = [],
  onReorder,
  onRemove,
  onTrim,
  onShuffle,
  clipScenes = {},
  detectingScenes,
  onDetectScenes,
  onAutoSplit
}) => {
  const dragItem = useRef<number | null>(null);
  const dragOverItem = useRef<number | null>(null);

  const handleDragStart = (e: React.DragEvent<HTMLDivElement>, position: number) => {
    dragItem.current = position;
    e.dataTransfer.effectAllowed = "move";
  };

  const handleDragEnter = (e: React.DragEvent<HTMLDivElement>, position: number) => {
    dragOverItem.current = position;
    e.preventDefault();
  };

  const handleDragEnd = () => {
    if (dragItem.current !== null && dragOverItem.current !== null && dragItem.current !== dragOverItem.current) {
      onReorder(dragItem.current, dragOverItem.current);
    }
    dragItem.current = null;
    dragOverItem.current = null;
  };

  if (clips.length === 0) return null;

  // Calculate Usage Stats
  const usageCounts = segments.reduce((acc, seg) => {
      acc[seg.videoIndex] = (acc[seg.videoIndex] || 0) + 1;
      return acc;
  }, {} as Record<number, number>);

  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-bold text-slate-500 uppercase flex items-center">
          <Film className="w-4 h-4 mr-2" /> 
          Clip Sequence
        </h3>
        {onShuffle && (
          <button 
             onClick={onShuffle}
             className="flex items-center text-xs font-bold text-cyan-400 hover:text-white transition-colors px-3 py-1 bg-slate-800 rounded-full border border-slate-700 hover:border-cyan-500"
          >
             <Shuffle className="w-3 h-3 mr-1" />
             SHUFFLE ASSIGNMENTS
          </button>
        )}
      </div>
      
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
        {clips.map((clip, index) => {
           const usage = usageCounts[index] || 0;
           let usageColor = "bg-slate-700 text-slate-400";
           if (usage === 0) usageColor = "bg-red-900/50 text-red-300 border border-red-800";
           else if (usage > 2) usageColor = "bg-yellow-900/50 text-yellow-300 border border-yellow-800";
           else usageColor = "bg-green-900/50 text-green-300 border border-green-800";

           return (
            <div
              key={clip.id}
              draggable
              onDragStart={(e) => handleDragStart(e, index)}
              onDragEnter={(e) => handleDragEnter(e, index)}
              onDragEnd={handleDragEnd}
              onDragOver={(e) => e.preventDefault()}
              className="relative group bg-slate-900 border border-slate-700 rounded-lg p-3 hover:border-cyan-500 transition-all cursor-move flex flex-col justify-between h-36 active:scale-95 active:shadow-inner"
            >
              <div className="flex items-start justify-between mb-2">
                <div className="flex items-center space-x-2 overflow-hidden">
                  <div className="bg-slate-800 p-1.5 rounded text-slate-400">
                    <GripVertical className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-200 truncate pr-2" title={clip.name}>
                      {clip.name}
                    </p>
                    <div className="flex items-center space-x-2 mt-1 flex-wrap gap-1">
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${usageColor}`}>
                            {usage === 0 ? 'Unused' : `${usage}x Used`}
                        </span>
                        {clipScenes[clip.id]?.length > 1 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-900/50 text-yellow-300 border border-yellow-800">
                            {clipScenes[clip.id].length} scenes
                          </span>
                        )}
                        <p className="text-xs text-slate-500 font-mono">
                        {clip.trimEnd > 0
                          ? `${(clip.trimEnd - clip.trimStart).toFixed(1)}s`
                          : '...'}
                        </p>
                    </div>
                  </div>
                </div>
                <div className="flex items-center space-x-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  {/* Scene Detection for long clips (>15s) */}
                  {clip.duration > 15 && onDetectScenes && !clipScenes[clip.id] && (
                    <button
                      onClick={() => onDetectScenes(clip.id, clip.url)}
                      disabled={detectingScenes === clip.id}
                      className="p-1.5 rounded-md hover:bg-slate-800 text-slate-400 hover:text-yellow-400 transition-colors disabled:opacity-50"
                      title="Detect Scenes"
                    >
                      {detectingScenes === clip.id ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <Scan className="w-4 h-4" />
                      )}
                    </button>
                  )}
                  {/* Auto-split button when scenes detected */}
                  {clipScenes[clip.id]?.length > 1 && onAutoSplit && (
                    <button
                      onClick={() => onAutoSplit(clip.id)}
                      className="p-1.5 rounded-md hover:bg-slate-800 text-yellow-400 hover:text-yellow-300 transition-colors"
                      title={`Split into ${clipScenes[clip.id].length} scenes`}
                    >
                      <SplitSquareHorizontal className="w-4 h-4" />
                    </button>
                  )}
                  <button
                    onClick={() => onTrim(clip)}
                    className="p-1.5 rounded-md hover:bg-slate-800 text-slate-400 hover:text-cyan-400 transition-colors"
                    title="Trim Clip"
                  >
                    <Scissors className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => onRemove(clip.id)}
                    className="p-1.5 rounded-md hover:bg-slate-800 text-slate-400 hover:text-red-400 transition-colors"
                    title="Remove Clip"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
              
              {/* Metadata Info */}
              <div className="flex space-x-3 mt-1 px-1 min-h-[16px]">
                {clip.metadata?.processed ? (
                    <>
                    <div className="flex items-center text-[10px] text-slate-500 font-mono" title="Avg Brightness">
                        <Sun className="w-3 h-3 mr-1 text-slate-600" />
                        {Math.round(clip.metadata.brightness * 100)}%
                    </div>
                    <div className="flex items-center text-[10px] text-slate-500 font-mono" title="Contrast / Variance">
                        <Contrast className="w-3 h-3 mr-1 text-slate-600" />
                        {Math.round(clip.metadata.contrast * 100)}%
                    </div>
                    </>
                ) : (
                    <div className="text-[10px] text-slate-700 font-mono animate-pulse">Analyzing...</div>
                )}
              </div>

              {/* Visual Bar representation of trim */}
              <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden mt-auto">
                <div 
                   className="h-full bg-cyan-500 opacity-80"
                   style={{
                     width: clip.duration > 0 ? `${((clip.trimEnd - clip.trimStart) / clip.duration) * 100}%` : '100%',
                     marginLeft: clip.duration > 0 ? `${(clip.trimStart / clip.duration) * 100}%` : '0%'
                   }}
                ></div>
              </div>
              
              {/* Index Badge */}
              <div className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-slate-800 border border-slate-600 text-slate-400 text-xs flex items-center justify-center font-mono shadow-sm">
                {index + 1}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default ClipManager;