import React, { useState, useCallback, useRef, useEffect } from "react";
import { Grid, List, SortAsc, FolderPlus } from "lucide-react";
import { useApp } from "../../contexts/AppContext";
import { Breadcrumbs } from "./Breadcrumbs";
import { MarqueeSelector } from "./MarqueeSelector";
import { ContextMenu } from "./ContextMenu";
import { FileItemComponent } from "./FileItem";

export const FileManager: React.FC = () => {
  const {
    files,
    selectedFiles,
    viewMode,
    setViewMode,
    setSelectedFiles,
    addSelectedFile,
    removeSelectedFile,
    clearSelection,
    openFolder,
    setCreateFolderModalOpen,
  } = useApp();

  const dragSelectingRef = useRef(false);
  const managerRef = useRef<HTMLDivElement>(null);

  // track marquee‐drag state in a ref only (we never read dragSelecting)
  const handleSelectingChange = useCallback((selecting: boolean) => {
    dragSelectingRef.current = selecting;
  }, []);

  const [contextMenu, setContextMenu] = useState<{
    isOpen: boolean;
    position: { x: number; y: number };
  }>({ isOpen: false, position: { x: 0, y: 0 } });

  useEffect(() => {
    const handleDocumentClick = (e: MouseEvent) => {
      if (dragSelectingRef.current) return;

      const manager = managerRef.current;
      if (manager && !manager.contains(e.target as Node)) {
        clearSelection();
      }
    };

    document.addEventListener("click", handleDocumentClick);

    return () => {
      document.removeEventListener("click", handleDocumentClick);
    };
  }, [clearSelection]);

  const handleFileClick = (fileId: string, e: React.MouseEvent) => {
    if (dragSelectingRef.current) return;

    e.preventDefault();
    e.stopPropagation(); // ← prevent the container’s onClick from firing

    if (e.ctrlKey || e.metaKey) {
      // Multi-select with Ctrl/Cmd
      if (selectedFiles.includes(fileId)) {
        removeSelectedFile(fileId);
      } else {
        addSelectedFile(fileId);
      }
    } else if (e.shiftKey && selectedFiles.length > 0) {
      // Range select with Shift
      const fileIds = files.map((f) => f.id);
      const lastSelectedIndex = fileIds.indexOf(
        selectedFiles[selectedFiles.length - 1],
      );
      const clickedIndex = fileIds.indexOf(fileId);

      const start = Math.min(lastSelectedIndex, clickedIndex);
      const end = Math.max(lastSelectedIndex, clickedIndex);
      const rangeIds = fileIds.slice(start, end + 1);

      setSelectedFiles([...new Set([...selectedFiles, ...rangeIds])]);
    } else {
      // Single select
      setSelectedFiles([fileId]);
    }
  };

  const handleFileDoubleClick = (file: any) => {
    if (file.type === "folder") {
      openFolder(file);
    } else {
      console.log("Open file:", file.name);
    }
  };

  const handleContextMenu = (e: React.MouseEvent, fileId?: string) => {
    e.preventDefault();

    if (fileId && !selectedFiles.includes(fileId)) {
      setSelectedFiles([fileId]);
    }

    setContextMenu({
      isOpen: true,
      position: { x: e.clientX, y: e.clientY },
    });
  };

  const handleMarqueeSelection = useCallback(
    (selectedIds: string[], additive: boolean) => {
      if (additive) {
        // merge current selection + new marquee hits
        const merged = Array.from(new Set([...selectedFiles, ...selectedIds]));
        setSelectedFiles(merged);
      } else {
        setSelectedFiles(selectedIds);
      }
    },
    [selectedFiles, setSelectedFiles],
  );

  return (
    <div className="p-6 space-y-6" ref={managerRef}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <Breadcrumbs />

        <div className="flex items-center space-x-2">
          <button
            onClick={() => setViewMode("grid")}
            className={`
              p-2 rounded-lg transition-colors duration-200
              ${
                viewMode === "grid"
                  ? "bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-400"
                  : "text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              }
            `}
          >
            <Grid className="w-5 h-5" />
          </button>

          <button
            onClick={() => setViewMode("list")}
            className={`
              p-2 rounded-lg transition-colors duration-200
              ${
                viewMode === "list"
                  ? "bg-blue-100 text-blue-600 dark:bg-blue-900/50 dark:text-blue-400"
                  : "text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              }
            `}
          >
            <List className="w-5 h-5" />
          </button>

          <button
            className="p-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 rounded-lg"
            onClick={() => setCreateFolderModalOpen(true)}
          >
            <FolderPlus className="w-5 h-5" />
          </button>

          <button className="p-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 rounded-lg">
            <SortAsc className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* File List */}
      <MarqueeSelector
        onSelectionChange={handleMarqueeSelection}
        onSelectingChange={handleSelectingChange}
      >
        <div
          className={`
            ${
              viewMode === "grid"
                ? "grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4"
                : "space-y-1"
            }
            min-h-[50vh]
          `}
          onClick={(e) => {
            // only clear if the click really hit the empty area
            if (e.target === e.currentTarget && !dragSelectingRef.current) {
              clearSelection();
            }
          }}
          onContextMenu={(e) => handleContextMenu(e)}
        >
          {files.map((file) => (
            <FileItemComponent
              key={file.id}
              file={file}
              isSelected={selectedFiles.includes(file.id)}
              viewMode={viewMode}
              onClick={(e) => handleFileClick(file.id, e)}
              onDoubleClick={() => handleFileDoubleClick(file)}
              onContextMenu={(e) => handleContextMenu(e, file.id)}
            />
          ))}
        </div>
      </MarqueeSelector>

      {/* Context Menu */}
      <ContextMenu
        isOpen={contextMenu.isOpen}
        position={contextMenu.position}
        onClose={() =>
          setContextMenu({ isOpen: false, position: { x: 0, y: 0 } })
        }
        selectedCount={selectedFiles.length}
      />
    </div>
  );
};
