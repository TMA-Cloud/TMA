import React from 'react';
import { type FileItem } from '../../contexts/AppContext';
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
  onCreateFolder: () => void;
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
  onCreateFolder,
}) => {
  const gridClassName = `grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-3`;

  const containerClassName = `
    ${viewMode === 'grid' ? gridClassName : 'space-y-1'}
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
      className={containerClassName}
      style={{ overflow: 'unset', height: 'auto' }}
      onClick={handleContainerClick}
      onContextMenu={e => onContextMenu(e)}
    >
      {files.length === 0 ? (
        <EmptyState
          searchQuery={searchQuery}
          isSearching={isSearching}
          currentPath={currentPath}
          canCreateFolder={canCreateFolder}
          onCreateFolder={onCreateFolder}
        />
      ) : isSearching ? (
        <FileSkeleton viewMode={viewMode} count={viewMode === 'grid' ? 12 : 8} />
      ) : (
        <>
          {files.map(file => (
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
              />
              {file.type === 'folder' && dragOverFolder === file.id && draggingIds.length > 1 && (
                <div className="drop-count-badge">{draggingIds.length}</div>
              )}
            </div>
          ))}
          {/* Dropzone highlight for drag-and-drop - disabled on mobile */}
          {dragOverFolder === null && draggingIds.length > 0 && !isMobile && (
            <div className="absolute inset-0 rounded-2xl border-2 border-dashed border-[#5b8def]/40 bg-[#5b8def]/8 dark:bg-[#5b8def]/15 pointer-events-none animate-fadeIn z-10" />
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
