import React from 'react';
import { type FileItem } from '../../contexts/AppContext';
import { formatFileSize, formatDate } from '../../utils/fileUtils';
import { Tooltip } from '../ui/Tooltip';
import { FileTypeIcon } from '../fileManager/FileTypeIcon';

interface RecentFilesProps {
  files: FileItem[];
}

export const RecentFiles: React.FC<RecentFilesProps> = ({ files }) => {
  const recent = files.slice(0, 5);

  return (
    <div className="card p-5 md:p-6">
      <h3 className="type-title-3 text-[var(--label)] mb-3">Recent files</h3>

      {recent.length === 0 ? (
        <p className="type-footnote text-[var(--label-tertiary)] py-6 text-center">Nothing here yet.</p>
      ) : (
        <div className="space-y-0.5">
          {recent.map(file => (
            <div
              key={file.id}
              className="pressable-lg flex items-center gap-3 p-2.5 rounded-xl hover:bg-[var(--fill-quaternary)] cursor-pointer"
            >
              <FileTypeIcon file={file} className="w-8 h-8 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <Tooltip text={file.name}>
                  <p className="type-callout type-emphasized text-[var(--label)] truncate">{file.name}</p>
                </Tooltip>
                <div className="type-caption text-[var(--label-tertiary)] flex items-center gap-1.5 mt-0.5">
                  {file.type === 'file' && file.size && (
                    <>
                      <span>{formatFileSize(file.size)}</span>
                      <span aria-hidden="true">·</span>
                    </>
                  )}
                  <span>{formatDate(file.modified)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
