import React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { type FileItem, useApp } from '../../contexts/AppContext';
import { FileItemComponent } from './FileItem';
import { FileSkeleton } from './FileSkeleton';
import { EmptyState } from './EmptyState';
import { MarqueeSelector } from './MarqueeSelector';

interface FileListProps {
  files: FileItem[];
  selectedFiles: string[];
  viewMode: 'grid' | 'list';
  isMobile: boolean;
  isSearching: boolean;
  searchQuery: string;
  currentPath: string[];
  canCreateFolder: boolean;
  dragOverFolder: string | null;
  draggingIds: string[];
  isSelecting: boolean;
  dragSelectingRef: React.MutableRefObject<boolean>;
  onFileClick: (fileId: string, e: React.MouseEvent) => void;
  onFileDoubleClick: (file: FileItem) => void;
  onContextMenu: (e: React.MouseEvent, fileId?: string) => void;
  onDragStart: (fileId: string) => (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onFolderDragOver: (folderId: string) => (e: React.DragEvent) => void;
  onFolderDragLeave: (folderId: string) => () => void;
  onFolderDrop: (folderId: string) => (e: React.DragEvent) => Promise<void>;
  onClearSelection: () => void;
  onMarqueeSelection: (selectedIds: string[], additive: boolean) => void;
  onSelectingChange: (selecting: boolean) => void;
  /** When set, the matching row scrolls into view after navigation (ref + useLayoutEffect in FileItem) */
  listScrollRequest?: { fileId: string; token: number } | null;
  onListScrollRequestHandled?: () => void;
}

export const FileList: React.FC<FileListProps> = ({
  files,
  selectedFiles,
  viewMode,
  isMobile,
  isSearching,
  searchQuery,
  currentPath,
  canCreateFolder,
  dragOverFolder,
  draggingIds,
  isSelecting,
  dragSelectingRef,
  onFileClick,
  onFileDoubleClick,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onFolderDragOver,
  onFolderDragLeave,
  onFolderDrop,
  onClearSelection,
  onMarqueeSelection,
  onSelectingChange,
  listScrollRequest,
  onListScrollRequestHandled,
}) => {
  const { hasMoreFiles, isLoadingMore, loadMoreFiles } = useApp();
  const loadMoreSentinelRef = React.useRef<HTMLDivElement | null>(null);
  const loadMoreFilesRef = React.useRef(loadMoreFiles);
  const isLoadingMoreRef = React.useRef(isLoadingMore);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = React.useState(0);
  const [scrollMargin, setScrollMargin] = React.useState(0);
  const columnCount = viewMode === 'grid' ? Math.max(1, Math.floor((containerWidth + 12) / 162)) : 1;
  const rowCount = Math.ceil(files.length / columnCount);
  // TanStack Virtual intentionally exposes mutable measurement functions.
  // eslint-disable-next-line react-hooks/incompatible-library
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => containerRef.current?.closest('main.scroller') as HTMLElement | null,
    estimateSize: () => (viewMode === 'grid' ? 190 : 53),
    overscan: 4,
    scrollMargin,
    getItemKey: index => files[index * columnCount]?.id || index,
  });

  React.useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const updateMeasurements = () => {
      const scroller = container.closest('main.scroller');
      setContainerWidth(container.clientWidth);
      if (scroller) {
        const scrollerRect = scroller.getBoundingClientRect();
        setScrollMargin(container.getBoundingClientRect().top - scrollerRect.top + scroller.scrollTop);
      }
    };
    updateMeasurements();
    const observer = new ResizeObserver(updateMeasurements);
    observer.observe(container);
    return () => observer.disconnect();
  }, [viewMode]);

  React.useLayoutEffect(() => {
    if (!listScrollRequest) return;
    const index = files.findIndex(file => file.id === listScrollRequest.fileId);
    if (index >= 0) rowVirtualizer.scrollToIndex(Math.floor(index / columnCount), { align: 'center' });
  }, [columnCount, files, listScrollRequest, rowVirtualizer]);

  React.useEffect(() => {
    loadMoreFilesRef.current = loadMoreFiles;
    isLoadingMoreRef.current = isLoadingMore;
  }, [isLoadingMore, loadMoreFiles]);

  React.useEffect(() => {
    const sentinel = loadMoreSentinelRef.current;
    if (!hasMoreFiles || !sentinel) return;

    const observer = new IntersectionObserver(
      entries => {
        if (entries[0]?.isIntersecting && !isLoadingMoreRef.current) {
          void loadMoreFilesRef.current();
        }
      },
      { rootMargin: '600px 0px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMoreFiles]);

  // Columns are sized from the container, not the viewport, so collapsing the sidebar adds a
  // column instead of just widening the cards. auto-fill (not auto-fit) leaves the trailing
  // empty tracks in place, which keeps a short row of files card-sized instead of letting the
  // last few stretch across the row. min() guards the case where the pane is narrower than a card.
  const containerClassName = `
    relative pb-12
    ${files.length === 0 ? 'flex flex-col items-center justify-center min-h-[calc(100vh-17rem)]' : 'min-h-[calc(100vh-17rem)]'}
  `;

  const handleContainerClick = (e: React.MouseEvent) => {
    // only clear if the click really hit the empty area
    if (e.target === e.currentTarget && !dragSelectingRef.current) {
      onClearSelection();
    }
  };

  const fileListContent = (
    <div
      ref={containerRef}
      className={containerClassName}
      style={{
        overflow: 'unset',
        height: files.length > 0 ? `${rowVirtualizer.getTotalSize() + (hasMoreFiles ? 32 : 0)}px` : 'auto',
      }}
      onClick={handleContainerClick}
      onContextMenu={e => onContextMenu(e)}
    >
      {files.length === 0 && !isSearching ? (
        <EmptyState
          searchQuery={searchQuery}
          isSearching={isSearching}
          currentPath={currentPath}
          canCreateFolder={canCreateFolder}
        />
      ) : files.length === 0 && isSearching ? (
        <FileSkeleton viewMode={viewMode} count={viewMode === 'grid' ? 12 : 8} />
      ) : (
        <>
          {rowVirtualizer.getVirtualItems().map(virtualRow => {
            const rowFiles = files.slice(virtualRow.index * columnCount, (virtualRow.index + 1) * columnCount);
            return (
              <div
                key={virtualRow.key}
                ref={rowVirtualizer.measureElement}
                data-index={virtualRow.index}
                className={
                  viewMode === 'grid' ? 'absolute left-0 grid w-full gap-3 pb-3' : 'absolute left-0 w-full pb-1'
                }
                style={{
                  top: 0,
                  transform: `translateY(${virtualRow.start - scrollMargin}px)`,
                  ...(viewMode === 'grid'
                    ? { gridTemplateColumns: `repeat(${columnCount}, minmax(min(150px, 100%), 1fr))` }
                    : {}),
                }}
              >
                {rowFiles.map(file => (
                  <div key={file.id} className="relative">
                    <FileItemComponent
                      file={file}
                      isSelected={selectedFiles.includes(file.id)}
                      viewMode={viewMode}
                      onClick={e => onFileClick(file.id, e)}
                      onDoubleClick={() => onFileDoubleClick(file)}
                      onContextMenu={e => onContextMenu(e, file.id)}
                      onDragStart={onDragStart(file.id)}
                      onDragEnd={onDragEnd}
                      onDragOver={file.type === 'folder' ? onFolderDragOver(file.id) : undefined}
                      onDragLeave={file.type === 'folder' ? onFolderDragLeave(file.id) : undefined}
                      onDrop={file.type === 'folder' ? onFolderDrop(file.id) : undefined}
                      isDragOver={dragOverFolder === file.id}
                      dragDisabled={isSelecting}
                      scrollIntoViewRequest={listScrollRequest}
                      onScrollIntoViewHandled={onListScrollRequestHandled}
                    />
                    {file.type === 'folder' && dragOverFolder === file.id && draggingIds.length > 1 && (
                      <div className="drop-count-badge">{draggingIds.length}</div>
                    )}
                  </div>
                ))}
              </div>
            );
          })}
          {hasMoreFiles && (
            <div
              ref={loadMoreSentinelRef}
              aria-hidden="true"
              className="absolute left-0 h-8 w-full"
              style={{ top: `${rowVirtualizer.getTotalSize()}px` }}
            >
              {isLoadingMore && <div className="h-full animate-pulse rounded bg-[var(--hover-bg)] opacity-40" />}
            </div>
          )}
          {/* Dropzone highlight for drag-and-drop - disabled on mobile */}
          {dragOverFolder === null && draggingIds.length > 0 && !isMobile && (
            <div className="absolute inset-0 rounded-2xl border border-dashed border-[var(--accent-ring)] bg-[var(--accent-fill)] pointer-events-none animate-fadeIn z-10" />
          )}
        </>
      )}
    </div>
  );

  if (isMobile) {
    return fileListContent;
  }

  return (
    <MarqueeSelector
      onSelectionChange={onMarqueeSelection}
      onSelectingChange={onSelectingChange}
      selectedFiles={selectedFiles}
    >
      {fileListContent}
    </MarqueeSelector>
  );
};
