import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Edit3,
  Trash2,
  Share2,
  Star,
  Copy,
  Scissors,
  ClipboardPaste,
  Download,
  Link2,
  CheckSquare,
  Square,
  RotateCcw,
} from "lucide-react";
import { useApp } from "../../contexts/AppContext";
import { useToast } from "../../hooks/useToast";
import { useIsMobile } from "../../hooks/useIsMobile";
import { Modal } from "../ui/Modal";

interface ContextMenuProps {
  isOpen: boolean;
  position: { x: number; y: number };
  onClose: () => void;
  selectedCount: number;
  targetId: string | null;
  multiSelectMode?: boolean;
  setMultiSelectMode?: (enabled: boolean) => void;
  onActionComplete?: () => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({
  isOpen,
  position,
  onClose,
  selectedCount,
  targetId,
  multiSelectMode = false,
  setMultiSelectMode,
  onActionComplete,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);
  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<{
    type: "delete" | "deleteForever";
    files: string[];
  } | null>(null);
  const isMobile = useIsMobile();

  const {
    selectedFiles,
    setClipboard,
    clipboard,
    pasteClipboard,
    folderStack,
    folderSharedStack,
    files,
    setRenameTarget,
    shareFiles,
    getShareLinks,
    linkToParentShare,
    starFiles,
    deleteFiles,
    restoreFiles,
    deleteForever,
    setShareLinkModalOpen,
    currentPath,
    downloadFiles,
    isDownloading,
    clearSelection,
  } = useApp();
  const { showToast } = useToast();

  const selectedItems = files.filter((f) => selectedFiles.includes(f.id));
  const allStarred =
    selectedItems.length > 0 && selectedItems.every((f) => f.starred);
  const allShared =
    selectedItems.length > 0 && selectedItems.every((f) => f.shared);
  const anyShared =
    selectedItems.length > 0 && selectedItems.some((f) => f.shared);
  const parentShared = folderSharedStack[folderSharedStack.length - 1];
  const allUnshared =
    selectedItems.length > 0 && selectedItems.every((f) => !f.shared);

  const isTrashView = currentPath[0] === "Trash";

  const handleRestore = useCallback(async () => {
    try {
      await restoreFiles(selectedFiles);
      const count = selectedFiles.length;
      clearSelection(); // Clear selection after successful restore
      showToast(
        `Restored ${count} item${count !== 1 ? "s" : ""} from trash`,
        "success",
      );
      onActionComplete?.();
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error("Failed to restore:", error);
      showToast(
        errorMessage || "Failed to restore files. Please try again.",
        "error",
      );
    }
  }, [
    restoreFiles,
    selectedFiles,
    clearSelection,
    showToast,
    onActionComplete,
  ]);

  const handleConfirmDelete = async () => {
    if (!pendingAction) return;

    setConfirmModalOpen(false);
    const { type, files } = pendingAction;
    const count = files.length;

    try {
      if (type === "deleteForever") {
        await deleteForever(files);
        clearSelection(); // Clear selection after successful deletion
        showToast(
          `Permanently deleted ${count} item${count !== 1 ? "s" : ""}`,
          "success",
        );
      } else {
        await deleteFiles(files);
        clearSelection(); // Clear selection after successful deletion
        showToast(
          `Moved ${count} item${count !== 1 ? "s" : ""} to trash`,
          "success",
        );
      }
      onActionComplete?.();
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      console.error(
        `Failed to ${type === "deleteForever" ? "delete forever" : "delete"}:`,
        error,
      );
      showToast(
        errorMessage ||
          `Failed to ${type === "deleteForever" ? "permanently delete" : "delete"}. Please try again.`,
        "error",
      );
    } finally {
      setPendingAction(null);
    }
  };

  const menuItems = useMemo(() => {
    // On trash page, show "Restore" and "Delete Forever" options
    if (isTrashView) {
      return [
        // Mobile-only: Select Multiple option
        ...(isMobile && setMultiSelectMode
          ? [
              {
                icon: multiSelectMode ? CheckSquare : Square,
                label: multiSelectMode
                  ? "Exit Multi-Select"
                  : "Select Multiple",
                action: () => {
                  if (setMultiSelectMode) {
                    setMultiSelectMode(!multiSelectMode);
                    if (multiSelectMode) {
                      // Clear selection when exiting multi-select mode
                      // This will be handled by FileManager if needed
                    }
                  }
                  onClose();
                },
              },
            ]
          : []),
        {
          icon: RotateCcw,
          label: "Restore",
          action: () => {
            handleRestore();
            onClose();
          },
        },
        {
          icon: Trash2,
          label: "Delete Forever",
          action: () => {
            setPendingAction({ type: "deleteForever", files: selectedFiles });
            setConfirmModalOpen(true);
            onClose();
          },
          danger: true,
        },
      ];
    }

    // Regular menu items for other pages
    return [
      // Mobile-only: Select Multiple option
      ...(isMobile && setMultiSelectMode
        ? [
            {
              icon: multiSelectMode ? CheckSquare : Square,
              label: multiSelectMode ? "Exit Multi-Select" : "Select Multiple",
              action: () => {
                if (setMultiSelectMode) {
                  setMultiSelectMode(!multiSelectMode);
                  if (multiSelectMode) {
                    // Clear selection when exiting multi-select mode
                    // This will be handled by FileManager if needed
                  }
                }
                onClose();
              },
            },
          ]
        : []),
      ...(parentShared && allUnshared
        ? [
            {
              icon: Share2,
              label: "Link to Folder Share",
              action: async () => {
                const links = await linkToParentShare(selectedFiles);
                const base = window.location.origin;
                const list = Object.values(links).map((t) => `${base}/s/${t}`);
                if (list.length) setShareLinkModalOpen(true, list);
                onActionComplete?.();
              },
            },
          ]
        : []),
      {
        icon: Share2,
        label: allShared ? "Remove from Shared" : "Add to Shared",
        action: async () => {
          const links = await shareFiles(selectedFiles, !allShared);
          if (!allShared) {
            const base = window.location.origin;
            const list = Object.values(links).map((t) => `${base}/s/${t}`);
            setShareLinkModalOpen(true, list);
          }
          onActionComplete?.();
        },
      },
      ...(anyShared
        ? [
            {
              icon: Link2,
              label: "Copy Link",
              action: async () => {
                const sharedIds = selectedItems
                  .filter((file) => file.shared)
                  .map((file) => file.id);
                if (sharedIds.length === 0) return;
                const links = await getShareLinks(sharedIds);
                const base = window.location.origin;
                const list = Object.values(links).map(
                  (token) => `${base}/s/${token}`,
                );
                if (!list.length) return;

                const text = list.join("\n");
                try {
                  if (navigator.clipboard?.writeText) {
                    await navigator.clipboard.writeText(text);
                  } else {
                    const textArea = document.createElement("textarea");
                    textArea.value = text;
                    textArea.style.position = "fixed";
                    textArea.style.left = "-999999px";
                    textArea.style.top = "-999999px";
                    document.body.appendChild(textArea);
                    textArea.focus();
                    textArea.select();
                    const successful = document.execCommand("copy");
                    document.body.removeChild(textArea);
                    if (!successful) throw new Error("Copy command failed");
                  }
                  showToast("Link copied to clipboard", "success");
                  onActionComplete?.();
                } catch (error) {
                  console.error("Failed to copy link:", error);
                  showToast("Failed to copy link", "error");
                }
              },
            },
          ]
        : []),
      {
        icon: Download,
        label: "Download",
        action: async () => {
          await downloadFiles(selectedFiles);
          onActionComplete?.();
        },
        disabled: isDownloading || selectedFiles.length === 0,
      },
      {
        icon: Star,
        label: allStarred ? "Remove from Starred" : "Add to Starred",
        action: async () => {
          await starFiles(selectedFiles, !allStarred);
          onActionComplete?.();
        },
      },
      {
        icon: Copy,
        label: "Copy",
        action: () => {
          setClipboard({ ids: selectedFiles, action: "copy" });
          onActionComplete?.();
        },
      },
      {
        icon: Scissors,
        label: "Cut",
        action: () => {
          setClipboard({ ids: selectedFiles, action: "cut" });
          onActionComplete?.();
        },
      },
      ...(clipboard
        ? [
            {
              icon: ClipboardPaste,
              label: "Paste",
              action: async () => {
                await pasteClipboard(
                  targetId ?? folderStack[folderStack.length - 1],
                );
                onActionComplete?.();
              },
            },
          ]
        : []),
      {
        icon: Edit3,
        label: "Rename",
        action: () => {
          const id = targetId ?? selectedFiles[0];
          const file = files.find((f) => f.id === id);
          if (file) setRenameTarget(file);
          onActionComplete?.();
        },
      },
      {
        icon: Trash2,
        label: "Delete",
        action: () => {
          setPendingAction({ type: "delete", files: selectedFiles });
          setConfirmModalOpen(true);
          onClose();
        },
        danger: true,
      },
    ];
  }, [
    isTrashView,
    parentShared,
    allUnshared,
    linkToParentShare,
    selectedFiles,
    selectedItems,
    setShareLinkModalOpen,
    shareFiles,
    getShareLinks,
    allShared,
    anyShared,
    starFiles,
    allStarred,
    setClipboard,
    clipboard,
    pasteClipboard,
    targetId,
    folderStack,
    files,
    setRenameTarget,
    downloadFiles,
    isDownloading,
    showToast,
    isMobile,
    multiSelectMode,
    setMultiSelectMode,
    onClose,
    handleRestore,
    onActionComplete,
  ]);

  useEffect(() => {
    if (!isOpen || isMobile) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleEscKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isOpen) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setFocusedIndex((prev) =>
          prev === null ? 0 : Math.min(prev + 1, menuItems.length - 1),
        );
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setFocusedIndex((prev) =>
          prev === null ? menuItems.length - 1 : Math.max(prev - 1, 0),
        );
      } else if (event.key === "Enter" && focusedIndex !== null) {
        event.preventDefault();
        const item = menuItems[focusedIndex];
        if (!item.disabled) {
          item.action();
          onClose();
        }
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscKey);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscKey);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, onClose, menuItems, focusedIndex, isMobile]);

  const confirmationTitle =
    pendingAction?.type === "deleteForever" ? "Delete Forever" : "Delete";
  const confirmationMessage =
    pendingAction?.type === "deleteForever"
      ? `Are you sure you want to permanently delete ${pendingAction.files.length} item${pendingAction.files.length !== 1 ? "s" : ""}? This action cannot be undone.`
      : `Are you sure you want to move ${pendingAction?.files.length || 0} item${(pendingAction?.files.length || 0) !== 1 ? "s" : ""} to trash?`;

  // Render modal outside of isOpen check so it persists when context menu closes
  const modalElement = (
    <Modal
      isOpen={confirmModalOpen}
      onClose={() => {
        setConfirmModalOpen(false);
        setPendingAction(null);
      }}
      title={confirmationTitle}
      size="sm"
    >
      <div className="space-y-4">
        <p className="text-gray-700 dark:text-gray-300">
          {confirmationMessage}
        </p>
        <div className="flex justify-end space-x-3 pt-4">
          <button
            onClick={() => {
              setConfirmModalOpen(false);
              setPendingAction(null);
            }}
            className="px-4 py-2 rounded-lg text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors duration-200"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirmDelete}
            className="px-4 py-2 rounded-lg text-white bg-red-600 hover:bg-red-700 dark:bg-red-500 dark:hover:bg-red-600 transition-colors duration-200"
          >
            {pendingAction?.type === "deleteForever"
              ? "Delete Forever"
              : "Delete"}
          </button>
        </div>
      </div>
    </Modal>
  );

  if (!isOpen) {
    // Still render modal even when context menu is closed
    return modalElement;
  }

  // Mobile: bottom sheet with overlay
  if (isMobile) {
    return (
      <>
        <div
          className="fixed inset-0 z-50 flex flex-col justify-end bg-black/40 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          onClick={onClose}
        >
          <div
            ref={menuRef}
            className="bg-white dark:bg-gray-900 rounded-t-2xl shadow-2xl pt-3 pb-4 px-4 max-h-[70vh] overflow-y-auto animate-slideUp"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-center mb-3">
              <div className="h-1 w-10 rounded-full bg-gray-300 dark:bg-gray-700" />
            </div>
            <div className="mb-2 text-center">
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {selectedCount} item{selectedCount !== 1 ? "s" : ""} selected
              </p>
            </div>
            <div className="space-y-1">
              {menuItems.map((item, index) => {
                const Icon = item.icon;
                return (
                  <button
                    key={index}
                    onClick={() => {
                      if (!item.disabled) {
                        item.action();
                        onClose();
                      }
                    }}
                    className={`
                      w-full flex items-center justify-between px-3 py-3 rounded-xl
                      text-sm
                      ${
                        item.disabled
                          ? "opacity-50 cursor-not-allowed text-gray-400 dark:text-gray-500"
                          : item.danger
                            ? "text-red-600 dark:text-red-400 bg-red-50/70 dark:bg-red-900/20"
                            : "text-gray-800 dark:text-gray-100 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100 dark:hover:bg-gray-700"
                      }
                    `}
                    disabled={item.disabled}
                  >
                    <div className="flex items-center space-x-3">
                      <Icon className="w-5 h-5" />
                      <span>{item.label}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        {modalElement}
      </>
    );
  }

  // Desktop: floating menu near cursor
  return (
    <>
      <div
        ref={menuRef}
        className="fixed z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-2xl py-2 min-w-48 transition-all duration-200 ease-out animate-menuIn focus:outline-none"
        style={{
          left: `${position.x}px`,
          top: `${position.y}px`,
        }}
        tabIndex={-1}
        role="menu"
        aria-label="File actions menu"
      >
        <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {selectedCount} item{selectedCount !== 1 ? "s" : ""} selected
          </p>
        </div>

        {menuItems.map((item, index) => {
          const Icon = item.icon;
          const isFocused = focusedIndex === index;
          return (
            <button
              key={index}
              onClick={() => {
                if (!item.disabled) {
                  item.action();
                  onClose();
                }
              }}
              className={`
                w-full flex items-center space-x-3 px-3 py-2 text-left
                transition-all duration-150
                rounded-md
                focus:outline-none
                ${
                  item.disabled
                    ? "opacity-50 cursor-not-allowed text-gray-400 dark:text-gray-500"
                    : isFocused
                      ? "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300"
                      : item.danger
                        ? "text-red-600 dark:text-red-400"
                        : "text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
                }
              `}
              disabled={item.disabled}
              tabIndex={0}
              role="menuitem"
              aria-selected={isFocused}
              onMouseEnter={() => setFocusedIndex(index)}
            >
              <Icon className="w-4 h-4" />
              <span className="text-sm">{item.label}</span>
            </button>
          );
        })}
      </div>
      {modalElement}
    </>
  );
};
