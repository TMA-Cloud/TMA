import React from 'react';
import { Grid, List, FolderPlus, Trash2, Share2, Star, Download, Edit3, RotateCcw } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { Tooltip } from '../ui/Tooltip';
import { SortMenu } from './SortMenu';

interface FileManagerToolbarProps {
  isMobile: boolean;
  viewMode: 'grid' | 'list';
  sortBy: string;
  sortOrder: 'asc' | 'desc';
  selectedFiles: string[];
  isTrashView: boolean;
  hasTrashFiles: boolean;
  canCreateFolder: boolean;
  allShared: boolean;
  allStarred: boolean;
  isDownloading: boolean;
  isDeleting: boolean;
  isRestoring: boolean;
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

type Tint = 'neutral' | 'accent' | 'positive' | 'warning' | 'destructive';

const TINTS: Record<Tint, { on: string; hover: string }> = {
  neutral: { on: 'text-[var(--label)] bg-[var(--fill-tertiary)]', hover: 'hover:text-[var(--label)]' },
  accent: { on: 'text-[var(--accent)] bg-[var(--accent-fill)]', hover: 'hover:text-[var(--accent)]' },
  positive: {
    on: 'text-[var(--positive-text)] bg-[var(--fill-quaternary)]',
    hover: 'hover:text-[var(--positive-text)]',
  },
  warning: { on: 'text-[var(--warning-text)] bg-[var(--fill-quaternary)]', hover: 'hover:text-[var(--warning-text)]' },
  destructive: {
    on: 'text-[var(--destructive-text)] bg-[var(--fill-quaternary)]',
    hover: 'hover:text-[var(--destructive-text)]',
  },
};

interface ToolbarButtonProps {
  label: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  onClick: () => void;
  /** The control is showing the state it toggles, not merely being available. */
  active?: boolean;
  disabled?: boolean;
  tint?: Tint;
  filled?: boolean;
}

/**
 * One shape for every toolbar action, so the eye can separate state from kind:
 * the position never moves, the tint says what the action does, and the fill
 * says whether it is currently on.
 */
const ToolbarButton: React.FC<ToolbarButtonProps> = ({
  label,
  icon: Icon,
  onClick,
  active = false,
  disabled = false,
  tint = 'neutral',
  filled = false,
}) => {
  const colours = TINTS[tint];
  return (
    <Tooltip text={label}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        aria-pressed={active}
        className={`pressable grid place-items-center w-9 h-9 rounded-full
          ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}
          ${
            active
              ? colours.on
              : `text-[var(--label-secondary)] hover:bg-[var(--fill-quaternary)] ${disabled ? '' : colours.hover}`
          }`}
      >
        <Icon className={`w-[18px] h-[18px] ${filled ? 'fill-current' : ''}`} strokeWidth={2} />
      </button>
    </Tooltip>
  );
};

export const FileManagerToolbar: React.FC<FileManagerToolbarProps> = ({
  isMobile,
  viewMode,
  sortBy,
  sortOrder,
  selectedFiles,
  isTrashView,
  hasTrashFiles,
  canCreateFolder,
  allShared,
  allStarred,
  isDownloading,
  isDeleting,
  isRestoring,
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
  // Actions a sub-user was not granted are left out entirely rather than shown
  // and rejected: the server would refuse them anyway, so displaying them only
  // produces a dead button and an error toast.
  const { can } = useAuth();

  return (
    <div className={`flex items-center ${isMobile ? 'justify-end w-full flex-wrap gap-1' : 'gap-0.5'}`}>
      {selectedFiles.length > 0 && !isTrashView && !isMobile && (
        <>
          {can('files.share') && (
            <ToolbarButton
              label={allShared ? 'Remove from Shared' : 'Add to Share'}
              icon={Share2}
              tint="positive"
              active={allShared}
              onClick={onShare}
            />
          )}

          {can('files.edit') && (
            <ToolbarButton
              label={allStarred ? 'Remove from Starred' : 'Add to Starred'}
              icon={Star}
              tint="warning"
              active={allStarred}
              filled={allStarred}
              onClick={onStar}
            />
          )}

          {can('files.download') && (
            <ToolbarButton
              label="Download"
              icon={Download}
              tint="accent"
              disabled={isDownloading || selectedFiles.length === 0}
              onClick={onDownload}
            />
          )}

          {can('files.edit') && (
            <ToolbarButton
              label="Rename"
              icon={Edit3}
              tint="accent"
              disabled={selectedFiles.length !== 1}
              onClick={onRename}
            />
          )}

          {can('files.delete') && (
            <ToolbarButton label="Delete" icon={Trash2} tint="destructive" disabled={isDeleting} onClick={onDelete} />
          )}

          {/* Separates what acts on the selection from what changes the view.
              Proximity is doing the grouping, so the gap has to mean something. */}
          <div className="w-px h-5 mx-1.5 bg-[var(--separator)]" />
        </>
      )}

      {isTrashView ? (
        <>
          {selectedFiles.length > 0 && can('files.trash') && (
            <>
              <ToolbarButton
                label="Restore"
                icon={RotateCcw}
                tint="positive"
                disabled={isRestoring}
                onClick={onRestore}
              />
              <ToolbarButton
                label="Delete Forever"
                icon={Trash2}
                tint="destructive"
                disabled={isDeleting}
                onClick={onDeleteForever}
              />
            </>
          )}
          {hasTrashFiles && selectedFiles.length === 0 && can('files.trash') && (
            <ToolbarButton label="Empty Trash" icon={Trash2} tint="destructive" onClick={onEmptyTrash} />
          )}
        </>
      ) : (
        <>
          <ToolbarButton
            label="Grid view"
            icon={Grid}
            tint="accent"
            active={viewMode === 'grid'}
            onClick={() => onViewModeChange('grid')}
          />
          <ToolbarButton
            label="List view"
            icon={List}
            tint="accent"
            active={viewMode === 'list'}
            onClick={() => onViewModeChange('list')}
          />

          {canCreateFolder && (
            <ToolbarButton label="Create folder" icon={FolderPlus} tint="positive" onClick={onCreateFolder} />
          )}

          <SortMenu sortBy={sortBy} sortOrder={sortOrder} onSortChange={onSortChange} />
        </>
      )}
    </div>
  );
};
