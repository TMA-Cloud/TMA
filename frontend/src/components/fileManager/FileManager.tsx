import React, { useState, useCallback, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  Grid,
  List,
  SortAsc,
  FolderPlus,
  Check,
  CheckSquare,
  X,
  Trash2,
} from "lucide-react";
import { useApp, type FileItem } from "../../contexts/AppContext";
import { Breadcrumbs } from "./Breadcrumbs";
import { MarqueeSelector } from "./MarqueeSelector";
import { ContextMenu } from "./ContextMenu";
import { FileItemComponent } from "./FileItem";
import { PasteProgress } from "./PasteProgress";
import { DownloadProgress } from "./DownloadProgress";
import { FileSkeleton } from "./FileSkeleton";
import { Tooltip } from "../ui/Tooltip";
import { ONLYOFFICE_EXTS, getExt } from "../../utils/fileUtils";
import { useIsMobile } from "../../hooks/useIsMobile";

const transparentImage = new Image();
transparentImage.src =
  "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

// separate scaling factors so we can tweak width/height individually
const PREVIEW_WIDTH_SCALE = 0.5;
const PREVIEW_HEIGHT_SCALE = 0.75;

const animateFlyToFolder = async (ids: string[], folderId: string) => {
  if (ids.length === 0) return;
  const target = document.querySelector<HTMLElement>(
    `[data-file-id="${folderId}"]`,
  );
  const first = document.querySelector<HTMLElement>(
    `[data-file-id="${ids[0]}"]`,
  );
  if (!target || !first) return;
  const targetRect = target.getBoundingClientRect();
  const startRect = first.getBoundingClientRect();

  const wrapper = document.createElement("div");
  wrapper.className = "drag-preview";
  wrapper.style.position = "fixed";
  wrapper.style.pointerEvents = "none";
  wrapper.style.top = `${startRect.top}px`;
  wrapper.style.left = `${startRect.left}px`;
  wrapper.style.width = `${startRect.width + 4 * (Math.min(ids.length, 3) - 1)}px`;
  wrapper.style.height = `${startRect.height + 4 * (Math.min(ids.length, 3) - 1)}px`;
  wrapper.style.transform = `scale(${PREVIEW_WIDTH_SCALE}, ${PREVIEW_HEIGHT_SCALE})`;
  wrapper.style.zIndex = "9999";
  wrapper.style.setProperty("--preview-scale-x", String(PREVIEW_WIDTH_SCALE));
  wrapper.style.setProperty("--preview-scale-y", String(PREVIEW_HEIGHT_SCALE));
  wrapper.style.setProperty("--badge-scale-x", String(1 / PREVIEW_WIDTH_SCALE));
  wrapper.style.setProperty(
    "--badge-scale-y",
    String(1 / PREVIEW_HEIGHT_SCALE),
  );

  const stack = document.createElement("div");
  stack.className = "preview-stack";
  wrapper.appendChild(stack);

  ids.slice(0, 3).forEach((id, idx) => {
    const el =
      document.querySelector<HTMLElement>(`[data-file-id="${id}"]`) ?? first;
    const rect = el.getBoundingClientRect();
    const clone = el.cloneNode(true) as HTMLElement;
    clone.classList.add("preview-item");
    clone.style.width = `${rect.width}px`;
    clone.style.height = `${rect.height}px`;
    clone.style.transform = `translate(${idx * 4}px, ${idx * 4}px)`;
    stack.appendChild(clone);
  });

  if (ids.length > 1) {
    const badge = document.createElement("div");
    badge.className = "preview-count";
    badge.textContent = String(ids.length);
    stack.appendChild(badge);
  }

  document.body.appendChild(wrapper);

  const deltaX = targetRect.left - startRect.left;
  const deltaY = targetRect.top - startRect.top;

  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      wrapper.style.transition =
        "transform 0.3s ease-in-out, opacity 0.3s ease-in-out";
      wrapper.style.transform = `translate(${deltaX}px, ${deltaY}px) scale(${PREVIEW_WIDTH_SCALE * 0.5}, ${PREVIEW_HEIGHT_SCALE * 0.5})`;
      wrapper.style.opacity = "0";
      wrapper.addEventListener(
        "transitionend",
        () => {
          wrapper.remove();
          resolve();
        },
        { once: true },
      );
    });
  });
};

let dragPreviewEl: HTMLDivElement | null = null;

const createDragPreview = (
  ids: string[],
  x: number,
  y: number,
  isMobile: boolean,
) => {
  removeDragPreview();
  if (ids.length === 0 || isMobile) return; // Disable drag preview on mobile
  const first = document.querySelector<HTMLElement>(
    `[data-file-id="${ids[0]}"]`,
  );
  if (!first) return;

  const wrapper = document.createElement("div");
  wrapper.className = "drag-preview";
  wrapper.style.position = "fixed";
  wrapper.style.pointerEvents = "none";
  wrapper.style.top = "0";
  wrapper.style.left = "0";
  wrapper.style.zIndex = "10000";

  // Compact chip
  const chip = document.createElement("div");
  chip.className = "drag-chip";

  // icon clone (SVG) – copy from card if available
  const iconSource = first.querySelector("svg");
  if (iconSource) {
    const icon = iconSource.cloneNode(true) as HTMLElement;
    icon.classList.add("drag-chip-icon");
    chip.appendChild(icon);
  }

  // name (single line)
  const name = first.querySelector("p");
  const nameText = name ? name.textContent || "" : "Selected";
  const nameEl = document.createElement("span");
  nameEl.className = "drag-chip-name";
  nameEl.textContent = nameText;
  chip.appendChild(nameEl);

  wrapper.appendChild(chip);

  if (ids.length > 1) {
    const count = document.createElement("div");
    count.className = "drag-chip-count";
    count.textContent = String(ids.length);
    wrapper.appendChild(count);
  }

  document.body.appendChild(wrapper);
  dragPreviewEl = wrapper as HTMLDivElement;
  moveDragPreview(x, y);
};

const moveDragPreview = (x: number, y: number) => {
  if (dragPreviewEl) {
    dragPreviewEl.style.transform = `translate(${x + 16}px, ${y + 16}px) scale(${PREVIEW_WIDTH_SCALE}, ${PREVIEW_HEIGHT_SCALE})`;
  }
};

const removeDragPreview = () => {
  if (dragPreviewEl) {
    dragPreviewEl.remove();
    dragPreviewEl = null;
  }
};

export const FileManager: React.FC = () => {
  const {
    files,
    selectedFiles,
    viewMode,
    currentPath,
    setViewMode,
    setSelectedFiles,
    addSelectedFile,
    removeSelectedFile,
    clearSelection,
    openFolder,
    setCreateFolderModalOpen,
    moveFiles,
    setImageViewerFile,
    pasteProgress,
    sortBy,
    sortOrder,
    setSortBy,
    setSortOrder,
    setDocumentViewerFile,
    searchQuery,
    isSearching,
    isDownloading,
    emptyTrash,
  } = useApp();

  const canCreateFolder = currentPath[0] === "My Files";
  const isTrashView = currentPath[0] === "Trash";
  const hasTrashFiles = isTrashView && files.length > 0;

  const handleEmptyTrash = async () => {
    if (
      !window.confirm(
        `Are you sure you want to permanently delete all ${files.length} item(s) from trash? This action cannot be undone.`,
      )
    ) {
      return;
    }

    try {
      await emptyTrash();
    } catch (error) {
      console.error("Failed to empty trash:", error);
    }
  };

  const dragSelectingRef = useRef(false);
  const managerRef = useRef<HTMLDivElement>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [draggingIds, setDraggingIds] = useState<string[]>([]);
  const [dragOverFolder, setDragOverFolder] = useState<string | null>(null);
  const [multiSelectMode, setMultiSelectMode] = useState(false);

  // track marquee‐drag state in a ref only (we never read dragSelecting)
  const handleSelectingChange = useCallback((selecting: boolean) => {
    dragSelectingRef.current = selecting;
    setIsSelecting(selecting);
  }, []);

  const [contextMenu, setContextMenu] = useState<{
    isOpen: boolean;
    position: { x: number; y: number };
    targetId: string | null;
  }>({ isOpen: false, position: { x: 0, y: 0 }, targetId: null });

  const [showSortMenu, setShowSortMenu] = useState(false);
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const sortButtonRef = useRef<HTMLButtonElement>(null);
  const [sortMenuPos, setSortMenuPos] = useState({ top: 0, right: 0 });

  const isMobile = useIsMobile();

  useEffect(() => {
    if (!showSortMenu) return;
    const handler = (e: MouseEvent) => {
      if (
        sortMenuRef.current &&
        !sortMenuRef.current.contains(e.target as Node)
      ) {
        setShowSortMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showSortMenu]);

  // Wrapper for clearSelection that also exits multi-select mode on mobile
  const handleClearSelection = useCallback(() => {
    clearSelection();
    if (isMobile && multiSelectMode) {
      setMultiSelectMode(false);
    }
  }, [clearSelection, isMobile, multiSelectMode]);

  // Wrapper for removeSelectedFile that exits multi-select mode when last file is deselected
  const handleRemoveSelectedFile = useCallback(
    (fileId: string) => {
      removeSelectedFile(fileId);
      if (isMobile && multiSelectMode && selectedFiles.length === 1) {
        // If this was the last selected file, exit multi-select mode
        setMultiSelectMode(false);
      }
    },
    [removeSelectedFile, isMobile, multiSelectMode, selectedFiles.length],
  );

  useEffect(() => {
    const handleDocumentClick = (e: MouseEvent) => {
      if (dragSelectingRef.current) return;

      const manager = managerRef.current;
      if (manager && !manager.contains(e.target as Node)) {
        handleClearSelection();
      }
    };

    document.addEventListener("click", handleDocumentClick);

    const handleDrag = (ev: DragEvent) => {
      if (!isMobile) {
        moveDragPreview(ev.clientX, ev.clientY);
      }
    };
    document.addEventListener("dragover", handleDrag);

    return () => {
      document.removeEventListener("click", handleDocumentClick);
      document.removeEventListener("dragover", handleDrag);
    };
  }, [handleClearSelection, isMobile]);

  const handleFileClick = (fileId: string, e: React.MouseEvent) => {
    if (dragSelectingRef.current) return;

    e.preventDefault();
    e.stopPropagation(); // ← prevent the container's onClick from firing

    // Mobile multi-select mode
    if (isMobile && multiSelectMode) {
      if (selectedFiles.includes(fileId)) {
        handleRemoveSelectedFile(fileId);
      } else {
        addSelectedFile(fileId);
      }
      return;
    }

    if (e.ctrlKey || e.metaKey) {
      // Multi-select with Ctrl/Cmd
      if (selectedFiles.includes(fileId)) {
        handleRemoveSelectedFile(fileId);
      } else {
        addSelectedFile(fileId);
      }
    } else if (e.shiftKey && selectedFiles.length > 0) {
      // Range select with Shift
      const fileIds = files.map((f) => f.id);
      const lastSelectedId = selectedFiles[selectedFiles.length - 1];
      if (!lastSelectedId) return; // Safety check
      const lastSelectedIndex = fileIds.indexOf(lastSelectedId);
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

  const handleFileDoubleClick = (file: FileItem) => {
    if (file.type === "folder" && currentPath[0] !== "Trash") {
      openFolder(file);
    } else {
      if (file.mimeType && file.mimeType.startsWith("image/")) {
        setImageViewerFile(file);
      } else if (ONLYOFFICE_EXTS.has(getExt(file.name))) {
        setDocumentViewerFile?.(file);
      }
    }
  };

  const handleContextMenu = (e: React.MouseEvent, fileId?: string) => {
    e.preventDefault();
    e.stopPropagation();

    if (fileId && !selectedFiles.includes(fileId)) {
      setSelectedFiles([fileId]);
    }

    setContextMenu({
      isOpen: true,
      position: { x: e.clientX, y: e.clientY },
      targetId: fileId ?? null,
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

  const handleDragStart = (fileId: string) => (e: React.DragEvent) => {
    if (dragSelectingRef.current || isMobile) {
      e.preventDefault();
      return;
    }
    if (!selectedFiles.includes(fileId)) {
      setSelectedFiles([fileId]);
      setDraggingIds([fileId]);
    } else {
      setDraggingIds(selectedFiles);
    }
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setDragImage(transparentImage, 0, 0);
    // mark global dragging state (used to suppress tooltips)
    document.body.classList.add("is-dragging");
    createDragPreview(
      selectedFiles.includes(fileId) ? selectedFiles : [fileId],
      e.clientX,
      e.clientY,
      isMobile,
    );
  };

  const handleDragEnd = () => {
    setDraggingIds([]);
    setDragOverFolder(null);
    removeDragPreview();
    document.body.classList.remove("is-dragging");
  };

  const handleFolderDragOver = (folderId: string) => (e: React.DragEvent) => {
    if (dragSelectingRef.current || draggingIds.length === 0) return;
    if (folderId && draggingIds.includes(folderId)) return;
    e.preventDefault();
    if (dragOverFolder !== folderId) setDragOverFolder(folderId);
  };

  const handleFolderDragLeave = (folderId: string) => () => {
    if (dragOverFolder === folderId) setDragOverFolder(null);
  };

  const handleFolderDrop = (folderId: string) => async (e: React.DragEvent) => {
    e.preventDefault();
    if (dragSelectingRef.current || draggingIds.length === 0) return;
    setDragOverFolder(null);
    removeDragPreview();
    await animateFlyToFolder(draggingIds, folderId);
    await moveFiles(draggingIds, folderId);
    setDraggingIds([]);
    document.body.classList.remove("is-dragging");
  };

  return (
    <div className={`${isMobile ? "p-3" : "p-6"} space-y-6`} ref={managerRef}>
      {/* Multi-Select Mode Indicator (Mobile Only) */}
      {isMobile && multiSelectMode && (
        <div className="bg-blue-500 text-white px-4 py-2 rounded-xl flex items-center justify-between mb-2 animate-slideDown">
          <div className="flex items-center space-x-2">
            <CheckSquare className="w-5 h-5" />
            <span className="text-sm font-medium">Multi-Select Mode</span>
            <span className="text-xs opacity-90">
              ({selectedFiles.length} selected)
            </span>
          </div>
          <button
            onClick={() => {
              setMultiSelectMode(false);
              handleClearSelection();
            }}
            className="text-white hover:text-blue-100 active:scale-95 transition"
            aria-label="Exit multi-select mode"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      )}

      {/* Header */}
      <div
        className={`${isMobile ? "flex-col space-y-3 px-3 py-3" : "flex items-center justify-between px-6 py-4"} rounded-2xl bg-white/80 dark:bg-gray-900/80 shadow-md mb-2 transition-all duration-300 backdrop-blur-lg border border-gray-200/50 dark:border-gray-700/50 animate-slideDown`}
      >
        <div className={`${isMobile ? "w-full" : "flex-1 min-w-0"}`}>
          <Breadcrumbs />
        </div>

        <div
          className={`flex items-center ${isMobile ? "justify-end w-full" : "space-x-2"}`}
        >
          {isTrashView ? (
            // Trash page: only show Empty Trash button
            hasTrashFiles && (
              <Tooltip text="Empty Trash">
                <button
                  className="p-2 rounded-xl text-gray-500 hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400 shadow-sm transition-all duration-300 hover:scale-110 active:scale-95 hover:bg-red-50 dark:hover:bg-red-900/20 hover:shadow-md"
                  onClick={handleEmptyTrash}
                  aria-label="Empty Trash"
                >
                  <Trash2 className="w-5 h-5 transition-transform duration-300" />
                </button>
              </Tooltip>
            )
          ) : (
            // Other pages: show all buttons
            <>
              <Tooltip text="Grid view">
                <button
                  onClick={() => setViewMode("grid")}
                  className={`
                    p-2 rounded-xl transition-all duration-300 ease-out shadow-sm
                    hover:scale-110 active:scale-95
                    ${
                      viewMode === "grid"
                        ? "bg-blue-100 text-blue-600 dark:bg-blue-900/60 dark:text-blue-400 shadow-lg scale-105"
                        : "text-gray-500 hover:text-blue-600 dark:text-gray-400 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20"
                    }
                  `}
                  aria-label="Grid view"
                >
                  <Grid className="w-5 h-5 transition-transform duration-300" />
                </button>
              </Tooltip>

              <Tooltip text="List view">
                <button
                  onClick={() => setViewMode("list")}
                  className={`
                    p-2 rounded-xl transition-all duration-300 ease-out shadow-sm
                    hover:scale-110 active:scale-95
                    ${
                      viewMode === "list"
                        ? "bg-blue-100 text-blue-600 dark:bg-blue-900/60 dark:text-blue-400 shadow-lg scale-105"
                        : "text-gray-500 hover:text-blue-600 dark:text-gray-400 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20"
                    }
                  `}
                  aria-label="List view"
                >
                  <List className="w-5 h-5 transition-transform duration-300" />
                </button>
              </Tooltip>

              {canCreateFolder && (
                <Tooltip text="Create folder">
                  <button
                    className="p-2 rounded-xl text-gray-500 hover:text-green-600 dark:text-gray-400 dark:hover:text-green-400 shadow-sm transition-all duration-300 hover:scale-110 active:scale-95 hover:bg-green-50 dark:hover:bg-green-900/20 hover:shadow-md"
                    onClick={() => setCreateFolderModalOpen(true)}
                    aria-label="Create folder"
                  >
                    <FolderPlus className="w-5 h-5 transition-transform duration-300" />
                  </button>
                </Tooltip>
              )}

              <div className="relative">
                <Tooltip text="Sort">
                  <button
                    ref={sortButtonRef}
                    className="p-2 rounded-xl text-gray-500 hover:text-purple-600 dark:text-gray-400 dark:hover:text-purple-400 shadow-sm transition-all duration-300 hover:scale-110 active:scale-95 hover:bg-purple-50 dark:hover:bg-purple-900/20 hover:shadow-md"
                    aria-label="Sort"
                    onClick={() => {
                      if (!showSortMenu && sortButtonRef.current) {
                        const rect =
                          sortButtonRef.current.getBoundingClientRect();
                        setSortMenuPos({
                          top: rect.bottom + 8,
                          right: window.innerWidth - rect.right,
                        });
                      }
                      setShowSortMenu((s) => !s);
                    }}
                  >
                    <SortAsc className="w-5 h-5 transition-transform duration-300" />
                  </button>
                </Tooltip>
                {showSortMenu &&
                  createPortal(
                    <>
                      {/* Overlay */}
                      <div
                        className="fixed inset-0 bg-white/30 dark:bg-white/10 transition-opacity duration-300 ease-in-out animate-fadeIn z-[9998]"
                        onClick={() => setShowSortMenu(false)}
                      />
                      {/* Sort menu */}
                      <div
                        ref={sortMenuRef}
                        className="fixed w-48 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl z-[9999] animate-menuIn"
                        style={{
                          top: `${sortMenuPos.top}px`,
                          right: `${sortMenuPos.right}px`,
                        }}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {(
                          [
                            { label: "Name (A-Z)", by: "name", order: "asc" },
                            { label: "Name (Z-A)", by: "name", order: "desc" },
                            {
                              label: "Modified (newest)",
                              by: "modified",
                              order: "desc",
                            },
                            {
                              label: "Modified (oldest)",
                              by: "modified",
                              order: "asc",
                            },
                            {
                              label: "Size (largest)",
                              by: "size",
                              order: "desc",
                            },
                            {
                              label: "Size (smallest)",
                              by: "size",
                              order: "asc",
                            },
                          ] as const
                        ).map((opt) => (
                          <button
                            key={opt.label}
                            onClick={() => {
                              setSortBy(opt.by);
                              setSortOrder(opt.order);
                              setShowSortMenu(false);
                            }}
                            className={`flex items-center w-full px-3 py-2 text-sm text-left transition-all duration-200 hover:bg-gray-100 dark:hover:bg-gray-700 hover:pl-4 ${
                              sortBy === opt.by && sortOrder === opt.order
                                ? "bg-gray-100 dark:bg-gray-700 font-semibold"
                                : ""
                            }`}
                          >
                            {sortBy === opt.by && sortOrder === opt.order && (
                              <Check className="w-4 h-4 mr-2" />
                            )}
                            {!(
                              sortBy === opt.by && sortOrder === opt.order
                            ) && <span className="w-4 h-4 mr-2" />}
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </>,
                    document.body,
                  )}
              </div>
            </>
          )}
        </div>
      </div>

      {/* File List */}
      {isMobile ? (
        <div
          className={`
            ${
              viewMode === "grid"
                ? `grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 ${isMobile ? "gap-2" : "gap-4"}`
                : "space-y-1"
            }
            min-h-[50vh] relative pb-32
            ${files.length === 0 ? "flex flex-col items-center justify-center" : ""}
          `}
          style={{ overflow: "unset", height: "auto" }}
          onClick={(e) => {
            // only clear if the click really hit the empty area
            if (e.target === e.currentTarget && !dragSelectingRef.current) {
              handleClearSelection();
            }
          }}
          onContextMenu={(e) => handleContextMenu(e)}
        >
          {files.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 text-center select-none animate-fadeIn">
              <svg
                width="80"
                height="80"
                fill="none"
                viewBox="0 0 80 80"
                className="mb-4 animate-bounceIn"
              >
                <rect
                  width="80"
                  height="80"
                  rx="20"
                  fill="#e0e7ef"
                  className="dark:fill-gray-800"
                />
                <path
                  d="M24 56V32a4 4 0 014-4h24a4 4 0 014 4v24"
                  stroke="#60a5fa"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M32 40h16"
                  stroke="#60a5fa"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <path
                  d="M32 48h16"
                  stroke="#60a5fa"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
              <h3 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-2">
                {searchQuery.trim().length > 0
                  ? isSearching
                    ? "Searching..."
                    : "No results found"
                  : currentPath[0] === "Starred"
                    ? "No starred files"
                    : currentPath[0] === "Shared"
                      ? "No shared files"
                      : currentPath[0] === "Trash"
                        ? "Trash is empty"
                        : "No files or folders"}
              </h3>
              <p className="text-gray-500 dark:text-gray-400 mb-4">
                {searchQuery.trim().length > 0
                  ? isSearching
                    ? "Please wait while we search your files..."
                    : `No files or folders match "${searchQuery}"`
                  : currentPath[0] === "Starred"
                    ? "Star files to easily find them later."
                    : currentPath[0] === "Shared"
                      ? "Files others share with you will show up here."
                      : currentPath[0] === "Trash"
                        ? "Deleted files will appear here."
                        : "Upload or create a folder to get started."}
              </p>
              {canCreateFolder && searchQuery.trim().length === 0 && (
                <button
                  className="px-6 py-3 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white rounded-xl shadow-lg hover:shadow-xl transition-all duration-300 font-semibold hover:scale-105 active:scale-95 transform animate-bounceIn"
                  onClick={() => setCreateFolderModalOpen(true)}
                >
                  Create Folder
                </button>
              )}
            </div>
          ) : isSearching ? (
            <FileSkeleton
              viewMode={viewMode}
              count={viewMode === "grid" ? 12 : 8}
            />
          ) : (
            files.map((file) => (
              <div key={file.id} className="relative">
                <FileItemComponent
                  file={file}
                  isSelected={selectedFiles.includes(file.id)}
                  viewMode={viewMode}
                  onClick={(e) => handleFileClick(file.id, e)}
                  onDoubleClick={() => handleFileDoubleClick(file)}
                  onContextMenu={(e) => handleContextMenu(e, file.id)}
                  onDragStart={handleDragStart(file.id)}
                  onDragEnd={handleDragEnd}
                  onDragOver={
                    file.type === "folder"
                      ? handleFolderDragOver(file.id)
                      : undefined
                  }
                  onDragLeave={
                    file.type === "folder"
                      ? handleFolderDragLeave(file.id)
                      : undefined
                  }
                  onDrop={
                    file.type === "folder"
                      ? handleFolderDrop(file.id)
                      : undefined
                  }
                  isDragOver={dragOverFolder === file.id}
                  dragDisabled={isSelecting}
                />
                {file.type === "folder" &&
                  dragOverFolder === file.id &&
                  draggingIds.length > 1 && (
                    <div className="drop-count-badge">{draggingIds.length}</div>
                  )}
              </div>
            ))
          )}
          {/* Dropzone highlight for drag-and-drop - disabled on mobile */}
          {dragOverFolder === null && draggingIds.length > 0 && !isMobile && (
            <div className="absolute inset-0 rounded-2xl border-4 border-blue-400 border-dashed bg-blue-100/40 dark:bg-blue-900/20 pointer-events-none animate-fadeIn z-10" />
          )}
        </div>
      ) : (
        <MarqueeSelector
          onSelectionChange={handleMarqueeSelection}
          onSelectingChange={handleSelectingChange}
          selectedFiles={selectedFiles}
        >
          <div
            className={`
            ${
              viewMode === "grid"
                ? `grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4`
                : "space-y-1"
            }
            min-h-[50vh] relative pb-32
            ${files.length === 0 ? "flex flex-col items-center justify-center" : ""}
          `}
            style={{ overflow: "unset", height: "auto" }}
            onClick={(e) => {
              // only clear if the click really hit the empty area
              if (e.target === e.currentTarget && !dragSelectingRef.current) {
                handleClearSelection();
              }
            }}
            onContextMenu={(e) => handleContextMenu(e)}
          >
            {files.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-64 text-center select-none animate-fadeIn">
                <svg
                  width="80"
                  height="80"
                  fill="none"
                  viewBox="0 0 80 80"
                  className="mb-4 animate-bounceIn"
                >
                  <rect
                    width="80"
                    height="80"
                    rx="20"
                    fill="#e0e7ef"
                    className="dark:fill-gray-800"
                  />
                  <path
                    d="M24 56V32a4 4 0 014-4h24a4 4 0 014 4v24"
                    stroke="#60a5fa"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M32 40h16"
                    stroke="#60a5fa"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                  <path
                    d="M32 48h16"
                    stroke="#60a5fa"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
                <h3 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-2">
                  {searchQuery.trim().length > 0
                    ? isSearching
                      ? "Searching..."
                      : "No results found"
                    : currentPath[0] === "Starred"
                      ? "No starred files"
                      : currentPath[0] === "Shared"
                        ? "No shared files"
                        : currentPath[0] === "Trash"
                          ? "Trash is empty"
                          : "No files or folders"}
                </h3>
                <p className="text-gray-500 dark:text-gray-400 mb-4">
                  {searchQuery.trim().length > 0
                    ? isSearching
                      ? "Please wait while we search your files..."
                      : `No files or folders match "${searchQuery}"`
                    : currentPath[0] === "Starred"
                      ? "Star files to easily find them later."
                      : currentPath[0] === "Shared"
                        ? "Files others share with you will show up here."
                        : currentPath[0] === "Trash"
                          ? "Deleted files will appear here."
                          : "Upload or create a folder to get started."}
                </p>
                {canCreateFolder && searchQuery.trim().length === 0 && (
                  <button
                    className="px-6 py-3 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white rounded-xl shadow-lg hover:shadow-xl transition-all duration-300 font-semibold hover:scale-105 active:scale-95 transform animate-bounceIn"
                    onClick={() => setCreateFolderModalOpen(true)}
                  >
                    Create Folder
                  </button>
                )}
              </div>
            ) : isSearching ? (
              <FileSkeleton
                viewMode={viewMode}
                count={viewMode === "grid" ? 12 : 8}
              />
            ) : (
              files.map((file) => (
                <div key={file.id} className="relative">
                  <FileItemComponent
                    file={file}
                    isSelected={selectedFiles.includes(file.id)}
                    viewMode={viewMode}
                    onClick={(e) => handleFileClick(file.id, e)}
                    onDoubleClick={() => handleFileDoubleClick(file)}
                    onContextMenu={(e) => handleContextMenu(e, file.id)}
                    onDragStart={handleDragStart(file.id)}
                    onDragEnd={handleDragEnd}
                    onDragOver={
                      file.type === "folder"
                        ? handleFolderDragOver(file.id)
                        : undefined
                    }
                    onDragLeave={
                      file.type === "folder"
                        ? handleFolderDragLeave(file.id)
                        : undefined
                    }
                    onDrop={
                      file.type === "folder"
                        ? handleFolderDrop(file.id)
                        : undefined
                    }
                    isDragOver={dragOverFolder === file.id}
                    dragDisabled={isSelecting}
                  />
                  {file.type === "folder" &&
                    dragOverFolder === file.id &&
                    draggingIds.length > 1 && (
                      <div className="drop-count-badge">
                        {draggingIds.length}
                      </div>
                    )}
                </div>
              ))
            )}
            {/* Dropzone highlight for drag-and-drop */}
            {dragOverFolder === null && draggingIds.length > 0 && (
              <div className="absolute inset-0 rounded-2xl border-4 border-blue-400 border-dashed bg-blue-100/40 dark:bg-blue-900/20 pointer-events-none animate-fadeIn z-10" />
            )}
          </div>
        </MarqueeSelector>
      )}

      {/* Context Menu */}
      <ContextMenu
        isOpen={contextMenu.isOpen}
        position={contextMenu.position}
        onClose={() =>
          setContextMenu({
            isOpen: false,
            position: { x: 0, y: 0 },
            targetId: null,
          })
        }
        targetId={contextMenu.targetId}
        selectedCount={selectedFiles.length}
        multiSelectMode={multiSelectMode}
        setMultiSelectMode={setMultiSelectMode}
      />

      <PasteProgress progress={pasteProgress} />
      <DownloadProgress
        isDownloading={isDownloading}
        hasFolders={selectedFiles.some(
          (id) => files.find((f) => f.id === id)?.type === "folder",
        )}
      />
    </div>
  );
};
