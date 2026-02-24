import React from 'react';
import { type FileItem } from '../../contexts/AppContext';
import { formatFileSize, formatDate } from '../../utils/fileUtils';
import { Tooltip } from '../ui/Tooltip';
import { FileTypeIcon } from '../fileManager/FileTypeIcon';

interface RecentFilesProps {
  files: FileItem[];
}

export const RecentFiles: React.FC<RecentFilesProps> = ({ files }) => {
  return (
    <div className="card-premium hover-lift p-6 md:p-8">
      <h3 className="text-lg md:text-xl font-bold text-gray-900 dark:text-gray-100 mb-5 tracking-tight">
        Recent Files
      </h3>

      <div className="space-y-2">
        {files.slice(0, 5).map(file => (
          <div
            key={file.id}
            className="flex items-center space-x-3 p-3.5 rounded-lg hover:bg-gray-50/80 dark:hover:bg-slate-800/60 cursor-pointer group transition-all duration-200 hover-lift"
          >
            <div className="flex-shrink-0">
              <FileTypeIcon file={file} className="w-8 h-8 transition-opacity duration-200 group-hover:opacity-100" />
            </div>
            <div className="flex-1 min-w-0">
              <Tooltip text={file.name}>
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">{file.name}</p>
              </Tooltip>
              <div className="text-xs text-gray-500/70 dark:text-gray-400/70 flex items-center space-x-2 mt-0.5">
                {file.type === 'file' && file.size && <span>{formatFileSize(file.size)}</span>}
                <span>•</span>
                <span>{formatDate(file.modified)}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
