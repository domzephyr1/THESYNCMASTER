import React from 'react';
import { Upload, Music, Film, CheckCircle } from 'lucide-react';

interface FileUploadProps {
  label: string;
  accept: string;
  multiple?: boolean;
  onFileSelect: (files: FileList | null) => void;
  selectedCount?: number;
  icon?: 'music' | 'video';
}

const FileUpload: React.FC<FileUploadProps> = ({ 
  label, 
  accept, 
  multiple = false, 
  onFileSelect, 
  selectedCount = 0,
  icon = 'music'
}) => {
  return (
    <div className="relative group">
      <label className="flex flex-col items-center justify-center w-full h-32 border-2 border-slate-700 border-dashed rounded-lg cursor-pointer bg-slate-900/50 hover:bg-slate-800 hover:border-cyan-500 hover:shadow-[0_0_15px_rgba(6,182,212,0.15)] transition-all duration-300">
        <div className="flex flex-col items-center justify-center pt-5 pb-6">
          {selectedCount > 0 ? (
            <div className="flex flex-col items-center text-cyan-400">
              <CheckCircle className="w-8 h-8 mb-2" />
              <p className="text-sm font-semibold">{selectedCount} file(s) selected</p>
            </div>
          ) : (
            <>
              {icon === 'music' ? (
                <Music className="w-8 h-8 mb-3 text-slate-400 group-hover:text-cyan-400 transition-colors" />
              ) : (
                <Film className="w-8 h-8 mb-3 text-slate-400 group-hover:text-cyan-400 transition-colors" />
              )}
              <p className="mb-2 text-sm text-slate-400">
                <span className="font-semibold text-slate-200">Click to upload</span> {label}
              </p>
              <p className="text-xs text-slate-500">
                {multiple ? 'MP4, MOV (Multiple)' : 'MP3, WAV (Single)'}
              </p>
            </>
          )}
        </div>
        <input 
          type="file" 
          className="hidden" 
          accept={accept} 
          multiple={multiple}
          onChange={(e) => onFileSelect(e.target.files)}
        />
      </label>
    </div>
  );
};

export default FileUpload;
