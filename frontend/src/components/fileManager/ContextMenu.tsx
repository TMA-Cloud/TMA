import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  MonitorDown,
} from 'lucide-react';
import { useApp, type ShareExpiry } from '../../contexts/AppContext';
import { useToast } from '../../hooks/useToast';
import { hasElectronClipboard, hasElectronOpenOnDesktop, MAX_COPY_TO_PC_BYTES } from '../../utils/electronDesktop';
import { useIsMobile } from '../../hooks/useIsMobile';
import { Modal } from '../ui/Modal';
import { getErrorMessage } from '../../utils/errorUtils';
import { ShareExpiryModal } from './ShareLinkModal';

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
  const [shareExpiryOpen, setShareExpiryOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<{
    type: 'delete' | 'deleteForever';
    files: string[];
  } | null>(null);
  const isMobile = useIsMobile();

  const {
    selectedFiles,
    setClipboard,
    clipboard,
    pasteClipboard,
    uploadFilesFromClipboard,
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
    copyFilesToPc,
    editFileWithDesktop,
    clearSelection,
  } = useApp();
  const { showToast } = useToast();

  const selectedItems = files.filter(f => selectedFiles.includes(f.id));
  const selectedFilesOnly = selectedItems.filter(f => String(f.type || '').toLowerCase() !== 'folder');
  const copyToPcTotalBytes = selectedFilesOnly.reduce((s, f) => s + Number(f.size ?? 0), 0);
  const canCopyToPc =
    selectedFilesOnly.length > 0 &&
    copyToPcTotalBytes <= MAX_COPY_TO_PC_BYTES &&
    selectedFilesOnly.every(f => f.size == null || Number(f.size) <= MAX_COPY_TO_PC_BYTES);
  const allStarred = selectedItems.length > 0 && selectedItems.every(f => f.starred);
  const allShared = selectedItems.length > 0 && selectedItems.every(f => f.shared);
  const anyShared = selectedItems.length > 0 && selectedItems.some(f => f.shared);
  const parentShared = folderSharedStack[folderSharedStack.length - 1];
  const allUnshared = selectedItems.length > 0 && selectedItems.every(f => !f.shared);

  const isTrashView = currentPath[0] === 'Trash';
  const singleSelectedItem = selectedItems.length === 1 ? selectedItems[0] : null;
  const canOpenOnDesktop =
    !isTrashView &&
    hasElectronOpenOnDesktop() &&
    !!singleSelectedItem &&
    String(singleSelectedItem.type || '').toLowerCase() !== 'folder' &&
    !!singleSelectedItem.mimeType &&
    (singleSelectedItem.mimeType.startsWith('application/vnd.openxmlformats-officedocument.') ||
      singleSelectedItem.mimeType === 'application/msword' ||
      singleSelectedItem.mimeType === 'application/pdf');

  const electronClipboardAvailable = hasElectronClipboard();

  const handleRestore = useCallback(async () => {
    try {
      await restoreFiles(selectedFiles);
      const count = selectedFiles.length;
      clearSelection(); // Clear selection after successful restore
      showToast(`Restored ${count} item${count !== 1 ? 's' : ''} from trash`, 'success');
      onActionComplete?.();
    } catch (error: unknown) {
      showToast(getErrorMessage(error, 'Failed to restore files. Please try again.'), 'error');
    }
  }, [restoreFiles, selectedFiles, clearSelection, showToast, onActionComplete]);

  const handleConfirmDelete = async () => {
    if (!pendingAction) return;

    setConfirmModalOpen(false);
    const { type, files } = pendingAction;
    const count = files.length;

    try {
      if (type === 'deleteForever') {
        await deleteForever(files);
        clearSelection(); // Clear selection after successful deletion
        showToast(`Permanently deleted ${count} item${count !== 1 ? 's' : ''}`, 'success');
      } else {
        await deleteFiles(files);
        clearSelection(); // Clear selection after successful deletion
        showToast(`Moved ${count} item${count !== 1 ? 's' : ''} to trash`, 'success');
      }
      onActionComplete?.();
    } catch (error: unknown) {
      showToast(
        getErrorMessage(
          error,
          `Failed to ${type === 'deleteForever' ? 'permanently delete' : 'delete'}. Please try again.`
        ),
        'error'
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
                label: multiSelectMode ? 'Exit Multi-Select' : 'Select Multiple',
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
          label: 'Restore',
          disabled: false,
          action: () => {
            handleRestore();
            onClose();
          },
        },
        {
          icon: Trash2,
          label: 'Delete Forever',
          disabled: false,
          action: () => {
            setPendingAction({ type: 'deleteForever', files: selectedFiles });
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
              label: multiSelectMode ? 'Exit Multi-Select' : 'Select Multiple',
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
              label: 'Link to Folder Share',
              action: async () => {
                try {
                  const links = await linkToParentShare(selectedFiles);
                  const list = Object.values(links);
                  if (list.length) setShareLinkModalOpen(true, list);
                  onActionComplete?.();
                } catch {
                  // Error handled by toast notification
                  showToast('Failed to link to parent share', 'error');
                }
              },
            },
          ]
        : []),
      {
        icon: Share2,
        label: allShared ? 'Remove from Shared' : 'Add to Shared',
        disabled: false,
        action: async () => {
          if (allShared) {
            try {
              await shareFiles(selectedFiles, false);
              onActionComplete?.();
            } catch {
              showToast('Failed to unshare files', 'error');
            }
          } else {
            // Show expiry picker — action continues in handleShareExpiry
            setShareExpiryOpen(true);
          }
        },
      },
      ...(anyShared
        ? [
            {
              icon: Link2,
              label: 'Copy Link',
              disabled: false,
              action: async () => {
                try {
                  const sharedIds = selectedItems.filter(file => file.shared).map(file => file.id);
                  if (sharedIds.length === 0) return;
                  const links = await getShareLinks(sharedIds);
                  const list = Object.values(links);
                  if (!list.length) return;

                  const text = list.join('\n');
                  try {
                    if (navigator.clipboard?.writeText) {
                      await navigator.clipboard.writeText(text);
                    } else {
                      const textArea = document.createElement('textarea');
                      textArea.value = text;
                      textArea.style.position = 'fixed';
                      textArea.style.left = '-999999px';
                      textArea.style.top = '-999999px';
                      document.body.appendChild(textArea);
                      textArea.focus();
                      textArea.select();
                      const successful = document.execCommand('copy');
                      document.body.removeChild(textArea);
                      if (!successful) throw new Error('Copy command failed');
                    }
                    showToast('Link copied to clipboard', 'success');
                    onActionComplete?.();
                  } catch {
                    // Error handled by toast notification
                    showToast('Failed to copy link', 'error');
                  }
                } catch {
                  // Error handled by toast notification
                  showToast('Failed to get share links', 'error');
                }
              },
            },
          ]
        : []),
      {
        icon: Download,
        label: 'Download',
        action: async () => {
          try {
            await downloadFiles(selectedFiles);
            onActionComplete?.();
          } catch {
            // Error handled by toast notification
            showToast('Failed to download files', 'error');
          }
        },
        disabled: isDownloading || selectedFiles.length === 0,
      },
      ...(!isTrashView && hasElectronOpenOnDesktop() && singleSelectedItem
        ? [
            {
              icon: MonitorDown,
              label: 'Open on desktop',
              disabled: !canOpenOnDesktop,
              action: async () => {
                const file = singleSelectedItem;
                if (!file) return;
                try {
                  await editFileWithDesktop(file.id);
                  onActionComplete?.();
                } catch {
                  showToast('Failed to open or save file from desktop.', 'error');
                }
              },
            },
          ]
        : []),
      ...(electronClipboardAvailable
        ? [
            {
              icon: MonitorDown,
              label: 'Copy',
              disabled: !canCopyToPc,
              action: async () => {
                try {
                  await copyFilesToPc(selectedFiles);
                  onActionComplete?.();
                } catch {
                  showToast('Failed to copy to computer', 'error');
                }
              },
            },
          ]
        : []),
      {
        icon: Star,
        label: allStarred ? 'Remove from Starred' : 'Add to Starred',
        disabled: false,
        action: async () => {
          try {
            await starFiles(selectedFiles, !allStarred);
            onActionComplete?.();
          } catch {
            // Error handled by toast notification
            showToast('Failed to update star status', 'error');
          }
        },
      },
      ...(electronClipboardAvailable
        ? [
            {
              icon: ClipboardPaste,
              label: 'Paste',
              disabled: false,
              action: async () => {
                try {
                  await uploadFilesFromClipboard();
                  onActionComplete?.();
                } catch (error) {
                  const errorMessage = error instanceof Error ? error.message : 'Failed to upload from clipboard';
                  showToast(errorMessage, 'error');
                }
              },
            },
          ]
        : []),
      {
        icon: Copy,
        label: electronClipboardAvailable ? 'Copy in cloud' : 'Copy',
        disabled: false,
        action: () => {
          setClipboard({ ids: selectedFiles, action: 'copy' });
          onActionComplete?.();
        },
      },
      {
        icon: Scissors,
        label: 'Cut',
        disabled: false,
        action: () => {
          setClipboard({ ids: selectedFiles, action: 'cut' });
          onActionComplete?.();
        },
      },
      ...(clipboard
        ? [
            {
              icon: ClipboardPaste,
              label: electronClipboardAvailable ? 'Paste in cloud' : 'Paste',
              disabled: false,
              action: async () => {
                try {
                  await pasteClipboard(targetId ?? folderStack[folderStack.length - 1] ?? null);
                  onActionComplete?.();
                } catch (error) {
                  // Error handled by toast notification
                  const errorMessage = error instanceof Error ? error.message : 'Failed to paste files';
                  showToast(errorMessage, 'error');
                }
              },
            },
          ]
        : []),
      {
        icon: Edit3,
        label: 'Rename',
        disabled: false,
        action: () => {
          const id = targetId ?? selectedFiles[0];
          const file = files.find(f => f.id === id);
          if (file) setRenameTarget(file);
          onActionComplete?.();
        },
      },
      {
        icon: Trash2,
        label: 'Delete',
        disabled: false,
        action: () => {
          setPendingAction({ type: 'delete', files: selectedFiles });
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
    canCopyToPc,
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
    uploadFilesFromClipboard,
    targetId,
    folderStack,
    files,
    setRenameTarget,
    downloadFiles,
    isDownloading,
    copyFilesToPc,
    singleSelectedItem,
    canOpenOnDesktop,
    editFileWithDesktop,
    showToast,
    isMobile,
    multiSelectMode,
    setMultiSelectMode,
    onClose,
    handleRestore,
    onActionComplete,
    electronClipboardAvailable,
  ]);

  // Calculate adjusted position immediately (before render) to prevent "flying" effect
  const calculateAdjustedPosition = useMemo(() => {
    if (isMobile || !isOpen) {
      return { x: position.x, y: position.y };
    }

    // Estimate menu dimensions (approximate)
    const estimatedMenuWidth = 192; // min-w-48 = 12rem = 192px
    const estimatedItemHeight = 40; // py-2.5 = ~40px per item
    const estimatedHeaderHeight = 40; // header section
    const estimatedMenuHeight = estimatedHeaderHeight + menuItems.length * estimatedItemHeight;

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const padding = 8;
    const cursorGap = 8; // Gap between cursor and menu when positioned to the left

    let adjustedX = position.x;
    let adjustedY = position.y;

    // Check right edge overflow - move to left of cursor with spacing
    if (position.x + estimatedMenuWidth + padding > viewportWidth) {
      adjustedX = position.x - estimatedMenuWidth - cursorGap;
    }

    // Check left edge overflow (if we moved it left)
    if (adjustedX < padding) {
      adjustedX = padding;
    }

    // Check bottom edge overflow - move above cursor with spacing
    if (position.y + estimatedMenuHeight + padding > viewportHeight) {
      adjustedY = position.y - estimatedMenuHeight - cursorGap;
    }

    // Check top edge overflow (if we moved it up)
    if (adjustedY < padding) {
      adjustedY = padding;
    }

    return { x: adjustedX, y: adjustedY };
  }, [isOpen, position, isMobile, menuItems.length]);

  useEffect(() => {
    if (!isOpen || isMobile) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleEscKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isOpen) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setFocusedIndex(prev => (prev === null ? 0 : Math.min(prev + 1, menuItems.length - 1)));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setFocusedIndex(prev => (prev === null ? menuItems.length - 1 : Math.max(prev - 1, 0)));
      } else if (event.key === 'Enter' && focusedIndex !== null) {
        event.preventDefault();
        const item = menuItems[focusedIndex];
        if (item && !item.disabled) {
          item.action();
          onClose();
        }
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscKey);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscKey);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose, menuItems, focusedIndex, isMobile]);

  const confirmationTitle = pendingAction?.type === 'deleteForever' ? 'Delete Forever' : 'Delete';
  const confirmationMessage =
    pendingAction?.type === 'deleteForever'
      ? `Are you sure you want to permanently delete ${pendingAction.files.length} item${pendingAction.files.length !== 1 ? 's' : ''}? This action cannot be undone.`
      : `Are you sure you want to move ${pendingAction?.files.length || 0} item${(pendingAction?.files.length || 0) !== 1 ? 's' : ''} to trash?`;

  const handleShareExpiry = async (expiry: ShareExpiry) => {
    setShareExpiryOpen(false);
    try {
      const links = await shareFiles(selectedFiles, true, expiry);
      const list = Object.values(links);
      if (list.length) setShareLinkModalOpen(true, list);
      onActionComplete?.();
    } catch {
      showToast('Failed to share files', 'error');
    }
  };

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
        <p className="text-gray-700 dark:text-gray-300">{confirmationMessage}</p>
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
            {pendingAction?.type === 'deleteForever' ? 'Delete Forever' : 'Delete'}
          </button>
        </div>
      </div>
    </Modal>
  );

  const shareExpiryElement = (
    <ShareExpiryModal
      isOpen={shareExpiryOpen}
      onClose={() => setShareExpiryOpen(false)}
      onConfirm={handleShareExpiry}
      fileCount={selectedFiles.length}
    />
  );

  if (!isOpen) {
    // Still render modals even when context menu is closed
    return (
      <>
        {modalElement}
        {shareExpiryElement}
      </>
    );
  }

  // Mobile: bottom sheet with overlay
  if (isMobile) {
    return (
      <>
        <div
          className="fixed inset-0 z-50 flex flex-col justify-end bg-black/20 dark:bg-black/40 backdrop-blur-sm animate-fadeIn"
          role="dialog"
          aria-modal="true"
          onClick={onClose}
        >
          <div
            ref={menuRef}
            className="bg-white/95 dark:bg-slate-800/95 backdrop-blur-xl rounded-t-2xl shadow-2xl pt-3 pb-4 px-4 max-h-[70vh] overflow-y-auto animate-slideUp"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-center mb-3">
              <div className="h-1 w-10 rounded-full bg-gray-300/50 dark:bg-gray-700/50" />
            </div>
            <div className="mb-3 text-center">
              <p className="text-xs font-medium text-gray-500/80 dark:text-gray-400/80">
                {selectedCount} item{selectedCount !== 1 ? 's' : ''} selected
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
                      w-full flex items-center justify-between px-4 py-3 rounded-lg
                      text-sm transition-all duration-200
                      ${
                        item.disabled
                          ? 'opacity-50 cursor-not-allowed text-gray-400 dark:text-gray-500'
                          : item.danger
                            ? 'text-red-600 dark:text-red-400 bg-red-50/80 dark:bg-red-900/20 hover:bg-red-100/80 dark:hover:bg-red-900/30'
                            : 'text-gray-800 dark:text-gray-100 hover:bg-gray-100/80 dark:hover:bg-slate-700/50'
                      }
                    `}
                    disabled={item.disabled}
                  >
                    <div className="flex items-center space-x-3">
                      <Icon className="w-5 h-5 icon-muted" />
                      <span className="font-medium">{item.label}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        {modalElement}
        {shareExpiryElement}
      </>
    );
  }

  // Desktop: floating menu near cursor
  return (
    <>
      <div
        ref={menuRef}
        className="fixed z-50 bg-white/95 dark:bg-slate-800/95 backdrop-blur-xl border border-gray-200/50 dark:border-slate-700/50 rounded-2xl shadow-2xl py-2 min-w-48 animate-menuIn focus:outline-none"
        style={{
          left: `${calculateAdjustedPosition.x}px`,
          top: `${calculateAdjustedPosition.y}px`,
        }}
        tabIndex={-1}
        role="menu"
        aria-label="File actions menu"
      >
        <div className="px-4 py-2.5 border-b border-gray-200/30 dark:border-slate-700/30">
          <p className="text-xs font-medium text-gray-500/80 dark:text-gray-400/80">
            {selectedCount} item{selectedCount !== 1 ? 's' : ''} selected
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
                w-full flex items-center space-x-3 px-4 py-2.5 text-left
                transition-all duration-150
                rounded-lg
                focus:outline-none
                ${
                  item.disabled
                    ? 'opacity-50 cursor-not-allowed text-gray-400 dark:text-gray-500'
                    : isFocused
                      ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                      : item.danger
                        ? 'text-red-600 dark:text-red-400 hover:bg-red-50/50 dark:hover:bg-red-900/20'
                        : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100/80 dark:hover:bg-slate-700/50'
                }
              `}
              disabled={item.disabled}
              tabIndex={0}
              role="menuitem"
              aria-selected={isFocused}
              onMouseEnter={() => setFocusedIndex(index)}
            >
              <Icon className="w-4 h-4 icon-muted" />
              <span className="text-sm font-medium">{item.label}</span>
            </button>
          );
        })}
      </div>
      {modalElement}
      {shareExpiryElement}
    </>
  );
};
