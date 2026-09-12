import React from 'react';
import { type FileItem } from '../../contexts/AppContext';
import { formatFileSize, formatDate } from '../../utils/fileUtils';
import { Tooltip } from '../ui/Tooltip';
import { FileTypeIcon } from '../fileManager/FileTypeIcon';

interface RecentFilesProps {
  files: FileItem[];
}

/**
 * The list arrives ordered and trimmed from /api/files/recent and this component
 * renders what it is given, so what is on screen is what the server ranked.
 */
export const RecentFiles: React.FC<RecentFilesProps> = ({ files }) => {
  return (
    <div className="card min-w-0 max-w-full overflow-hidden p-5 md:p-6">
      <h3 className="type-title-3 text-[var(--label)] mb-3">Recent files</h3>

      {files.length === 0 ? (
        <p className="type-footnote text-[var(--label-tertiary)] py-6 text-center">Nothing here yet.</p>
      ) : (
        <div className="min-w-0 space-y-0.5">
          {files.map(file => (
            <div
              key={file.id}
              className="pressable-lg flex w-full min-w-0 items-center gap-3 overflow-hidden p-2.5 rounded-xl hover:bg-[var(--fill-quaternary)] cursor-pointer"
            >
              <FileTypeIcon file={file} className="w-8 h-8 flex-shrink-0" />
              <div className="min-w-0 flex-1 overflow-hidden">
                <Tooltip text={file.name} anchorClassName="block w-full min-w-0">
                  <p className="type-callout type-emphasized block w-full truncate text-[var(--label)]">{file.name}</p>
                </Tooltip>
                <div className="type-caption mt-0.5 flex min-w-0 items-center gap-1.5 overflow-hidden text-[var(--label-tertiary)]">
                  {file.size ? (
                    <>
                      <span className="flex-shrink-0">{formatFileSize(file.size)}</span>
                      <span className="flex-shrink-0" aria-hidden="true">
                        ·
                      </span>
                    </>
                  ) : null}
                  {/* The ordering is by last opened */}
                  <span className="min-w-0 truncate">Opened {formatDate(file.accessedAt ?? file.modified)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
