import React, { useRef } from 'react';
import { type FileItem as FileItemType, useApp } from '../../contexts/AppContext';
import { formatFileSize, formatDate, getDisplayFileName } from '../../utils/fileUtils';
import { Star, Share2, Eye, Clock } from 'lucide-react';
import { useIsMobile } from '../../hooks/useIsMobile';
import { FileTypeIcon } from './FileTypeIcon';

interface FileItemProps {
  file: FileItemType;
  isSelected: boolean;
  viewMode: 'grid' | 'list';
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  isDragOver?: boolean;
  dragDisabled?: boolean;
}

export const FileItemComponent: React.FC<FileItemProps> = ({
  file,
  isSelected,
  viewMode,
  onClick,
  onDoubleClick,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  isDragOver,
  dragDisabled,
}) => {
  const isMobile = useIsMobile();
  const { hideFileExtensions } = useApp();
  const displayName = getDisplayFileName(file.name, file.type === 'file', hideFileExtensions);
  const longPressTimeoutRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);
  const isExpired = file.shared && file.expiresAt instanceof Date && file.expiresAt < new Date();

  const clearLongPress = () => {
    if (longPressTimeoutRef.current !== null) {
      window.clearTimeout(longPressTimeoutRef.current);
      longPressTimeoutRef.current = null;
    }
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (!isMobile || dragDisabled) return;
    clearLongPress();
    longPressTriggeredRef.current = false;

    const touch = e.touches[0];
    if (!touch) return;
    const clientX = touch.clientX;
    const clientY = touch.clientY;

    longPressTimeoutRef.current = window.setTimeout(() => {
      longPressTriggeredRef.current = true;
      // Synthesize a mouse-like event for the existing onContextMenu handler
      const syntheticEvent = {
        ...e,
        clientX,
        clientY,
        preventDefault: () => {},
        stopPropagation: () => {},
      } as unknown as React.MouseEvent;
      onContextMenu(syntheticEvent);
    }, 500); // 500ms press-and-hold
  };

  const handleTouchEnd = () => {
    if (!isMobile) return;
    clearLongPress();
  };

  const handleTouchMove = () => {
    if (!isMobile) return;
    // Cancel long press if the finger moves (user is scrolling/dragging)
    clearLongPress();
  };

  const handleClickWrapped = (e: React.MouseEvent) => {
    if (isMobile && longPressTriggeredRef.current) {
      // Suppress the click that follows a long-press
      e.preventDefault();
      e.stopPropagation();
      longPressTriggeredRef.current = false;
      return;
    }
    onClick(e);
  };

  const handleContextMenuWrapped = (e: React.MouseEvent) => {
    if (isMobile) {
      // Prevent native context menu on mobile; we rely on long-press instead
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    onContextMenu(e);
  };

  if (viewMode === 'grid') {
    return (
      <div
        data-file-id={file.id}
        className={`
          stagger-item group relative rounded-2xl border cursor-pointer
          transition-all duration-300 ease-out
          hover:z-20 hover:shadow-soft hover:border-[#5b8def]/30 dark:hover:border-[#5b8def]/40
          active:scale-[0.98]
          min-w-0 w-full p-3 ${isMobile ? 'select-none' : ''}
          overflow-hidden
          ${
            isSelected
              ? 'border-[#5b8def]/50 dark:border-[#5b8def]/50 bg-[#5b8def]/10 dark:bg-[#5b8def]/20 shadow-soft ring-2 ring-[#5b8def]/25 dark:ring-[#5b8def]/30'
              : 'border-slate-200/60 dark:border-slate-700/50 bg-[#f0f3f7] dark:bg-slate-800/50 hover:border-[#5b8def]/25 dark:hover:border-[#5b8def]/35 hover:bg-slate-200/40 dark:hover:bg-slate-700/50'
          }
          ${isDragOver ? 'ring-4 ring-[#5b8def]/40 ring-offset-2 scale-[1.02]' : ''}
        `}
        style={{ maxWidth: '100%' }}
        onClick={handleClickWrapped}
        onDoubleClick={onDoubleClick}
        onContextMenu={handleContextMenuWrapped}
        draggable={!dragDisabled && !isMobile}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchMove={handleTouchMove}
      >
        <div className="flex flex-col items-center text-center w-full min-w-0 gap-1.5">
          <div className="relative mb-1.5 flex-shrink-0">
            <FileTypeIcon file={file} className="w-12 h-12 transition-all duration-200" />
            {file.starred && <Star className="absolute -top-0.5 -right-0.5 w-4 h-4 text-yellow-400 fill-yellow-400" />}
            {file.shared && !isExpired && <Share2 className="absolute -top-0.5 -left-0.5 w-4 h-4 text-green-400" />}
            {isExpired && <Clock className="absolute -top-0.5 -left-0.5 w-4 h-4 text-red-400" />}
            {file.type === 'file' && !isMobile && (
              <button
                className="absolute -bottom-3 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 scale-90 group-hover:scale-100 bg-[#f0f3f7] dark:bg-slate-800 border border-slate-200/60 dark:border-slate-600 rounded-full p-1.5 shadow-soft hover:shadow-soft-md hover:bg-[#5b8def]/15 dark:hover:bg-[#5b8def]/25 hover:border-[#5b8def]/30 transition-all duration-300 ease-out"
                tabIndex={-1}
                title="Quick preview"
                onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                  e.stopPropagation();
                  onDoubleClick();
                }}
              >
                <Eye className="w-4 h-4 text-[#5b8def] dark:text-blue-400 transition-colors duration-300" />
              </button>
            )}
          </div>

          <div className="w-full min-w-0 px-1">
            <div className="w-full min-w-0">
              <p
                className="text-sm font-semibold text-slate-800 dark:text-slate-100 w-full break-words transition-colors duration-300"
                style={{
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  wordBreak: 'break-word',
                  overflowWrap: 'break-word',
                  hyphens: 'auto',
                  width: '100%',
                  maxWidth: '100%',
                  lineHeight: '1.3',
                }}
              >
                {displayName}
              </p>
            </div>
          </div>

          <div className="text-xs text-slate-500 dark:text-slate-400 w-full min-w-0 px-1">
            {file.type === 'file' && file.size && <p className="truncate">{formatFileSize(file.size)}</p>}
            <p className="truncate">{formatDate(file.modified)}</p>
            {isExpired && <p className="truncate text-red-400 font-medium">Link expired</p>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      data-file-id={file.id}
      className={`
        stagger-item group flex items-center gap-3 py-2.5 px-3 rounded-2xl cursor-pointer
        transition-all duration-300 ease-out
        hover:bg-slate-200/40 dark:hover:bg-slate-700/50
        active:scale-[0.99]
        ${isMobile ? 'select-none' : ''}
        ${
          isSelected
            ? 'bg-[#5b8def]/10 dark:bg-[#5b8def]/20 shadow-soft border-l-4 border-[#5b8def] dark:border-[#5b8def] ring-2 ring-[#5b8def]/20 dark:ring-[#5b8def]/25'
            : 'border-l-4 border-transparent'
        }
        ${isDragOver ? 'ring-4 ring-[#5b8def]/40 ring-offset-2 scale-[1.01]' : ''}
      `}
      onClick={handleClickWrapped}
      onDoubleClick={onDoubleClick}
      onContextMenu={handleContextMenuWrapped}
      draggable={!dragDisabled && !isMobile}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchMove={handleTouchMove}
    >
      <div className="relative flex-shrink-0">
        <FileTypeIcon file={file} className="w-10 h-10 transition-all duration-200" />
        {file.starred && <Star className="absolute -top-1 -right-1 w-4 h-4 text-yellow-400 fill-yellow-400" />}
        {file.shared && !isExpired && <Share2 className="absolute -top-1 -left-1 w-4 h-4 text-green-400" />}
        {isExpired && <Clock className="absolute -top-1 -left-1 w-4 h-4 text-red-400" />}
        {file.type === 'file' && (
          <button
            className="absolute -bottom-3 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 scale-90 group-hover:scale-100 bg-[#f0f3f7] dark:bg-slate-800 border border-slate-200/60 dark:border-slate-600 rounded-full p-1 shadow-soft hover:shadow-soft-md hover:bg-[#5b8def]/15 dark:hover:bg-[#5b8def]/25 hover:border-[#5b8def]/30 transition-all duration-300 ease-out"
            tabIndex={-1}
            title="Quick preview"
            onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
              e.stopPropagation();
              onDoubleClick();
            }}
          >
            <Eye className="w-4 h-4 text-[#5b8def] dark:text-blue-400 transition-colors duration-300" />
          </button>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="w-full min-w-0">
          <p
            className="text-base font-semibold text-slate-800 dark:text-slate-100 transition-colors duration-300 break-words leading-tight"
            style={{
              wordBreak: 'break-word',
              overflowWrap: 'break-word',
              hyphens: 'auto',
              lineHeight: '1.4',
            }}
          >
            {displayName}
          </p>
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400 transition-colors duration-300">
          {file.type === 'file' && file.size && `${formatFileSize(file.size)} • `}
          {formatDate(file.modified)}
          {isExpired && <span className="ml-2 text-red-400 font-medium">Link expired</span>}
        </p>
      </div>
    </div>
  );
};
