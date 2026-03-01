import React from 'react';
import { Grid, List, FolderPlus, Trash2, Share2, Star, Download, Edit3, RotateCcw } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';
import { SortMenu } from './SortMenu';

interface FileManagerToolbarProps {
  isMobile: boolean;
  viewMode: 'grid' | 'list';
  sortBy: string;
  sortOrder: 'asc' | 'desc';
  selectedFiles: string[];
  isTrashView: boolean;
  isSharedView: boolean;
  isStarredView: boolean;
  hasTrashFiles: boolean;
  canCreateFolder: boolean;
  allShared: boolean;
  allStarred: boolean;
  isDownloading: boolean;
  onViewModeChange: (mode: 'grid' | 'list') => void;
  onSortChange: (by: string, order: 'asc' | 'desc') => void;
  onCreateFolder: () => void;
  onShare: () => void;
  onStar: () => void;
  onDownload: () => void;
  onRename: () => void;
  onDelete: () => void;
  onRestore: () => void;
  onDeleteForever: () => void;
  onEmptyTrash: () => void;
}

export const FileManagerToolbar: React.FC<FileManagerToolbarProps> = ({
  isMobile,
  viewMode,
  sortBy,
  sortOrder,
  selectedFiles,
  isTrashView,
  isSharedView,
  isStarredView,
  hasTrashFiles,
  canCreateFolder,
  allShared,
  allStarred,
  isDownloading,
  onViewModeChange,
  onSortChange,
  onCreateFolder,
  onShare,
  onStar,
  onDownload,
  onRename,
  onDelete,
  onRestore,
  onDeleteForever,
  onEmptyTrash,
}) => {
  const btnBase =
    'p-2.5 rounded-2xl transition-all duration-300 ease-out hover-lift focus:outline-none focus:ring-2 focus:ring-[#5b8def]/40';
  const btnMuted =
    'text-slate-500 dark:text-slate-400 hover:bg-slate-200/50 dark:hover:bg-slate-700/50 hover:text-slate-700 dark:hover:text-slate-200';

  return (
    <div className={`flex items-center ${isMobile ? 'justify-end w-full flex-wrap gap-2' : 'gap-1.5'}`}>
      {selectedFiles.length > 0 && !isTrashView && !isMobile && (
        <>
          {!isSharedView && (
            <Tooltip text={allShared ? 'Remove from Shared' : 'Add to Share'}>
              <button
                className={`${btnBase} ${
                  allShared
                    ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 dark:bg-emerald-500/20'
                    : `${btnMuted} hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-500/10 dark:hover:bg-emerald-500/20`
                }`}
                onClick={() => onShare()}
                aria-label={allShared ? 'Remove from Shared' : 'Add to Share'}
              >
                <Share2
                  className={`w-5 h-5 icon-muted ${allShared ? 'fill-emerald-600 dark:fill-emerald-400 opacity-100' : ''}`}
                />
              </button>
            </Tooltip>
          )}

          {!isStarredView && (
            <Tooltip text={allStarred ? 'Remove from Starred' : 'Add to Starred'}>
              <button
                className={`${btnBase} ${
                  allStarred
                    ? 'text-amber-500 dark:text-amber-400 bg-amber-500/10 dark:bg-amber-500/20'
                    : `${btnMuted} hover:text-amber-500 dark:hover:text-amber-400 hover:bg-amber-500/10 dark:hover:bg-amber-500/20`
                }`}
                onClick={() => onStar()}
                aria-label={allStarred ? 'Remove from Starred' : 'Add to Starred'}
              >
                <Star
                  className={`w-5 h-5 icon-muted ${allStarred ? 'fill-amber-500 dark:fill-amber-400 opacity-100' : ''}`}
                />
              </button>
            </Tooltip>
          )}

          <Tooltip text="Download">
            <button
              className={`${btnBase} ${
                isDownloading || selectedFiles.length === 0
                  ? 'opacity-50 cursor-not-allowed pointer-events-none text-slate-400'
                  : `${btnMuted} hover:text-[#5b8def] dark:hover:text-blue-400 hover:bg-[#5b8def]/10 dark:hover:bg-[#5b8def]/20`
              }`}
              onClick={e => {
                if (isDownloading || selectedFiles.length === 0) {
                  e.preventDefault();
                  e.stopPropagation();
                  return;
                }
                onDownload();
              }}
              disabled={isDownloading || selectedFiles.length === 0}
              aria-label="Download"
            >
              <Download className="w-5 h-5 icon-muted" />
            </button>
          </Tooltip>

          <Tooltip text="Rename">
            <button
              className={`${btnBase} ${
                selectedFiles.length !== 1
                  ? 'opacity-50 cursor-not-allowed pointer-events-none text-slate-400'
                  : `${btnMuted} hover:text-violet-500 dark:hover:text-violet-400 hover:bg-violet-500/10 dark:hover:bg-violet-500/20`
              }`}
              onClick={e => {
                if (selectedFiles.length !== 1) {
                  e.preventDefault();
                  e.stopPropagation();
                  return;
                }
                onRename();
              }}
              disabled={selectedFiles.length !== 1}
              aria-label="Rename"
            >
              <Edit3 className="w-5 h-5 icon-muted" />
            </button>
          </Tooltip>

          <Tooltip text="Delete">
            <button
              className={`${btnBase} ${btnMuted} hover:text-red-500 dark:hover:text-red-400 hover:bg-red-500/10 dark:hover:bg-red-500/20`}
              onClick={() => onDelete()}
              aria-label="Delete"
            >
              <Trash2 className="w-5 h-5 icon-muted" />
            </button>
          </Tooltip>
        </>
      )}
      {isTrashView ? (
        <>
          {selectedFiles.length > 0 && (
            <>
              <Tooltip text="Restore">
                <button
                  className={`${btnBase} ${btnMuted} hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-500/10 dark:hover:bg-emerald-500/20`}
                  onClick={() => onRestore()}
                  aria-label="Restore"
                >
                  <RotateCcw className="w-5 h-5" />
                </button>
              </Tooltip>
              <Tooltip text="Delete Forever">
                <button
                  className={`${btnBase} ${btnMuted} hover:text-red-500 dark:hover:text-red-400 hover:bg-red-500/10 dark:hover:bg-red-500/20`}
                  onClick={() => onDeleteForever()}
                  aria-label="Delete Forever"
                >
                  <Trash2 className="w-5 h-5" />
                </button>
              </Tooltip>
            </>
          )}
          {hasTrashFiles && selectedFiles.length === 0 && (
            <Tooltip text="Empty Trash">
              <button
                className={`${btnBase} ${btnMuted} hover:text-red-500 dark:hover:text-red-400 hover:bg-red-500/10 dark:hover:bg-red-500/20`}
                onClick={() => onEmptyTrash()}
                aria-label="Empty Trash"
              >
                <Trash2 className="w-5 h-5" />
              </button>
            </Tooltip>
          )}
        </>
      ) : (
        <>
          <Tooltip text="Grid view">
            <button
              onClick={() => onViewModeChange('grid')}
              className={`${btnBase} ${
                viewMode === 'grid'
                  ? 'bg-[#5b8def]/15 dark:bg-[#5b8def]/25 text-[#4a7edb] dark:text-blue-400'
                  : `${btnMuted} hover:text-[#5b8def] dark:hover:text-blue-400 hover:bg-[#5b8def]/10 dark:hover:bg-[#5b8def]/20`
              }`}
              aria-label="Grid view"
            >
              <Grid className="w-5 h-5" />
            </button>
          </Tooltip>

          <Tooltip text="List view">
            <button
              onClick={() => onViewModeChange('list')}
              className={`${btnBase} ${
                viewMode === 'list'
                  ? 'bg-[#5b8def]/15 dark:bg-[#5b8def]/25 text-[#4a7edb] dark:text-blue-400'
                  : `${btnMuted} hover:text-[#5b8def] dark:hover:text-blue-400 hover:bg-[#5b8def]/10 dark:hover:bg-[#5b8def]/20`
              }`}
              aria-label="List view"
            >
              <List className="w-5 h-5" />
            </button>
          </Tooltip>

          {canCreateFolder && (
            <Tooltip text="Create folder">
              <button
                className={`${btnBase} ${btnMuted} hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-500/10 dark:hover:bg-emerald-500/20`}
                onClick={() => onCreateFolder()}
                aria-label="Create folder"
              >
                <FolderPlus className="w-5 h-5" />
              </button>
            </Tooltip>
          )}

          <SortMenu sortBy={sortBy} sortOrder={sortOrder} onSortChange={onSortChange} />
        </>
      )}
    </div>
  );
};
