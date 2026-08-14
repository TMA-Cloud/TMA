import React, { useRef, useLayoutEffect, useEffect } from 'react';
import { type FileItem as FileItemType, useApp } from '../../contexts/AppContext';
import { formatFileSize, formatDate, getDisplayFileName } from '../../utils/fileUtils';
import { Star, Share2, Eye, Clock } from 'lucide-react';
import { useIsMobile } from '../../hooks/useIsMobile';
import { FileTypeIcon } from './FileTypeIcon';
import { usePress } from '../../motion';

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
  scrollIntoViewRequest?: { fileId: string; token: number } | null;
  onScrollIntoViewHandled?: () => void;
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
  scrollIntoViewRequest,
  onScrollIntoViewHandled,
}) => {
  const isMobile = useIsMobile();
  const { hideFileExtensions, clipboard } = useApp();
  const displayName = getDisplayFileName(file.name, file.type === 'file', hideFileExtensions);
  const rootRef = useRef<HTMLDivElement>(null);
  const longPressTimeoutRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);
  const isExpired = file.shared && file.expiresAt instanceof Date && file.expiresAt < new Date();
  const isCut = clipboard?.action === 'cut' && clipboard.ids.includes(file.id);
  const cutClass = isCut ? 'opacity-45' : '';

  // The row answers the press itself, on pointer-down, rather than waiting for
  // the click to resolve into a selection. Dragging off cancels it; dragging
  // back restores it, so nothing is committed until the finger lifts.
  const { pressProps } = usePress<HTMLDivElement>({ disabled: dragDisabled });

  useLayoutEffect(() => {
    if (!scrollIntoViewRequest || scrollIntoViewRequest.fileId !== file.id) return;
    rootRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [file.id, scrollIntoViewRequest]);

  useEffect(() => {
    if (!scrollIntoViewRequest || scrollIntoViewRequest.fileId !== file.id) return;
    onScrollIntoViewHandled?.();
  }, [file.id, scrollIntoViewRequest, onScrollIntoViewHandled]);

  useEffect(() => {
    return () => {
      if (longPressTimeoutRef.current !== null) {
        window.clearTimeout(longPressTimeoutRef.current);
      }
    };
  }, []);

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

  const sharedHandlers = {
    onClick: handleClickWrapped,
    onDoubleClick,
    onContextMenu: handleContextMenuWrapped,
    draggable: !dragDisabled && !isMobile,
    onDragStart,
    onDragEnd,
    onDragOver,
    onDragLeave,
    onDrop,
    onTouchStart: handleTouchStart,
    onTouchEnd: handleTouchEnd,
    onTouchMove: handleTouchMove,
  };

  // A folder that is about to receive the drop grows very slightly toward the
  // pointer: the in-between frames say where this is going, they do not just
  // interpolate to it.
  const dropTarget = isDragOver ? 'ring-2 ring-[var(--accent)] bg-[var(--accent-fill)] scale-[1.02]' : '';

  const badge = (
    <>
      {file.starred && (
        <Star className="absolute -top-1 -right-1 w-3.5 h-3.5 text-[var(--warning-text)] fill-[var(--warning-text)]" />
      )}
      {file.shared && !isExpired && (
        <Share2 className="absolute -top-1 -left-1 w-3.5 h-3.5 text-[var(--positive-text)]" />
      )}
      {isExpired && <Clock className="absolute -top-1 -left-1 w-3.5 h-3.5 text-[var(--destructive-text)]" />}
    </>
  );

  const previewButton = (size: 'sm' | 'md') => (
    <button
      className={`absolute -bottom-2.5 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 scale-90 group-hover:scale-100 material-thick material-edge rounded-full ${
        size === 'md' ? 'p-1.5' : 'p-1'
      } transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]`}
      tabIndex={-1}
      title="Quick preview"
      onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
        e.stopPropagation();
        onDoubleClick();
      }}
    >
      <Eye className="w-3.5 h-3.5 text-[var(--accent)]" strokeWidth={2.25} />
    </button>
  );

  if (viewMode === 'grid') {
    return (
      <div
        ref={rootRef}
        data-file-id={file.id}
        {...pressProps}
        {...sharedHandlers}
        className={`
          stagger-item pressable-lg group relative rounded-2xl border cursor-pointer
          min-w-0 w-full p-3 overflow-hidden ${isMobile ? 'select-none' : ''}
          ${
            isSelected
              ? 'border-[var(--accent)] bg-[var(--accent-fill)]'
              : 'border-[var(--separator)] bg-[var(--surface)] hover:bg-[var(--fill-quaternary)]'
          }
          ${dropTarget}
          ${cutClass}
        `}
        style={{ maxWidth: '100%' }}
      >
        <div className="flex flex-col items-center text-center w-full min-w-0 gap-1.5">
          <div className="relative mb-1.5 flex-shrink-0">
            <FileTypeIcon file={file} className="w-11 h-11" />
            {badge}
            {file.type === 'file' && !isMobile && previewButton('md')}
          </div>

          <div className="w-full min-w-0 px-1">
            <p
              className="type-caption type-emphasized text-[var(--label)] w-full break-words"
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
              }}
            >
              {displayName}
            </p>
          </div>

          <div className="type-caption-2 text-[var(--label-tertiary)] w-full min-w-0 px-1">
            {file.type === 'file' && file.size && <p className="truncate">{formatFileSize(file.size)}</p>}
            <p className="truncate">{formatDate(file.modified)}</p>
            {isExpired && <p className="truncate text-[var(--destructive-text)]">Link expired</p>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      data-file-id={file.id}
      {...pressProps}
      {...sharedHandlers}
      className={`
        stagger-item pressable-lg group flex items-center gap-3 py-2 px-3 cursor-pointer rounded-xl
        ${isMobile ? 'select-none' : ''}
        ${
          isSelected
            ? 'bg-[var(--accent-fill)] shadow-[inset_0_0_0_1px_var(--accent-ring)]'
            : 'hover:bg-[var(--fill-quaternary)]'
        }
        ${dropTarget}
        ${cutClass}
      `}
    >
      <div className="relative flex-shrink-0">
        <FileTypeIcon file={file} className="w-9 h-9" />
        {badge}
        {file.type === 'file' && previewButton('sm')}
      </div>

      <div className="flex-1 min-w-0">
        <p
          className="type-callout type-emphasized text-[var(--label)] break-words"
          style={{
            wordBreak: 'break-word',
            overflowWrap: 'break-word',
            hyphens: 'auto',
          }}
        >
          {displayName}
        </p>
        <p className="type-caption text-[var(--label-tertiary)]">
          {file.type === 'file' && file.size && `${formatFileSize(file.size)} · `}
          {formatDate(file.modified)}
          {isExpired && <span className="ml-2 text-[var(--destructive-text)]">Link expired</span>}
        </p>
      </div>
    </div>
  );
};
