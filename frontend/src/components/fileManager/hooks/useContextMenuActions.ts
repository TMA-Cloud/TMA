import { useCallback, useMemo, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  ClipboardPaste,
  Copy,
  Download,
  Edit3,
  Info,
  Link2,
  MonitorDown,
  RotateCcw,
  Scissors,
  Share2,
  Square,
  CheckSquare,
  Star,
  Trash2,
} from 'lucide-react';
import { useApp, type FileItem, type ShareExpiry } from '../../../contexts/AppContext';
import { useAuth } from '../../../contexts/AuthContext';
import { useToast } from '../../../hooks/useToast';
import { hasElectronClipboard, hasElectronOpenOnDesktop } from '../../../utils/electronDesktop';
import { isOnlyOfficeSupported } from '../../../utils/fileUtils';
import { getErrorMessage } from '../../../utils/errorUtils';
import { copyToClipboard } from '../../../utils/clipboard';

export interface ContextMenuItem {
  icon: LucideIcon;
  label: string;
  action: () => void;
  disabled?: boolean;
  danger?: boolean;
}

interface ContextMenuActionsParams {
  targetId: string | null;
  isMobile: boolean;
  multiSelectMode: boolean;
  setMultiSelectMode?: (enabled: boolean) => void;
  onClose: () => void;
  onActionComplete?: () => void;
}

/** Derives the context-menu items from selection + grants, and owns the delete/share/info follow-ups. */
export function useContextMenuActions({
  targetId,
  isMobile,
  multiSelectMode,
  setMultiSelectMode,
  onClose,
  onActionComplete,
}: ContextMenuActionsParams) {
  const {
    selectedFiles,
    setClipboard,
    clipboard,
    clipboardCopy,
    clipboardPaste,
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
    isDeleting,
    isRestoring,
    setShareLinkModalOpen,
    currentPath,
    downloadFiles,
    isDownloading,
    editFileWithDesktop,
    clearSelection,
  } = useApp();
  // A sub-user only sees granted entries; anything else would be a dead item.
  const { can } = useAuth();
  const { showToast } = useToast();

  const [confirmModalOpen, setConfirmModalOpen] = useState(false);
  const [shareExpiryOpen, setShareExpiryOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [infoFile, setInfoFile] = useState<FileItem | null>(null);
  const [pendingAction, setPendingAction] = useState<{
    type: 'delete' | 'deleteForever';
    files: string[];
  } | null>(null);

  const selectedItems = files.filter(f => selectedFiles.includes(f.id));
  const allStarred = selectedItems.length > 0 && selectedItems.every(f => f.starred);
  const allShared = selectedItems.length > 0 && selectedItems.every(f => f.shared);
  const anyShared = selectedItems.length > 0 && selectedItems.some(f => f.shared);
  const parentShared = folderSharedStack[folderSharedStack.length - 1];
  const allUnshared = selectedItems.length > 0 && selectedItems.every(f => !f.shared);

  const isTrashView = currentPath[0] === 'Trash';
  const singleSelectedItem = selectedItems.length === 1 ? selectedItems[0] : null;

  const singleSelectedMime = (singleSelectedItem?.mimeType || '').toLowerCase();

  // "Open on desktop" for Office-type files (by extension) and image/video/audio.
  const canOpenOnDesktop =
    !isTrashView &&
    hasElectronOpenOnDesktop() &&
    !!singleSelectedItem &&
    String(singleSelectedItem.type || '').toLowerCase() !== 'folder' &&
    (isOnlyOfficeSupported(singleSelectedItem.name) ||
      singleSelectedMime.startsWith('image/') ||
      singleSelectedMime.startsWith('video/') ||
      singleSelectedMime.startsWith('audio/'));

  const electronClipboardAvailable = hasElectronClipboard();

  // Copy-paste creates (upload grant); cut-paste moves (edit grant).
  const canPaste = clipboard?.action === 'cut' ? can('files.edit') : can('files.upload');

  const handleRestore = useCallback(async () => {
    if (isRestoring) return;
    try {
      await restoreFiles(selectedFiles);
      const count = selectedFiles.length;
      clearSelection(); // Clear selection after successful restore
      showToast(`Restored ${count} item${count !== 1 ? 's' : ''} from trash`, 'success');
      onActionComplete?.();
    } catch (error: unknown) {
      showToast(getErrorMessage(error, 'Failed to restore items'), 'error');
    }
  }, [restoreFiles, selectedFiles, clearSelection, showToast, onActionComplete, isRestoring]);

  const handleConfirmDelete = async () => {
    if (!pendingAction) return;
    if (isDeleting) return;

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
        getErrorMessage(error, `Failed to ${type === 'deleteForever' ? 'delete permanently' : 'move items to trash'}`),
        'error'
      );
    } finally {
      setPendingAction(null);
    }
  };

  const handleShareExpiry = async (expiry: ShareExpiry) => {
    setShareExpiryOpen(false);
    try {
      const links = await shareFiles(selectedFiles, true, expiry);
      const list = Object.values(links);
      if (list.length) setShareLinkModalOpen(true, list);
      onActionComplete?.();
    } catch {
      showToast('Failed to share items', 'error');
    }
  };

  const menuItems = useMemo<ContextMenuItem[]>(() => {
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
        ...(can('files.trash')
          ? [
              {
                icon: RotateCcw,
                label: 'Restore',
                disabled: isRestoring,
                action: () => {
                  handleRestore();
                  onClose();
                },
              },
              {
                icon: Trash2,
                label: 'Delete Forever',
                disabled: isDeleting,
                action: () => {
                  setPendingAction({ type: 'deleteForever', files: selectedFiles });
                  setConfirmModalOpen(true);
                  onClose();
                },
                danger: true,
              },
            ]
          : []),
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
      ...(parentShared && allUnshared && can('files.share')
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
      ...(can('files.share')
        ? [
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
                    showToast('Failed to unshare items', 'error');
                  }
                } else {
                  // Show expiry picker — action continues in handleShareExpiry
                  setShareExpiryOpen(true);
                }
              },
            },
          ]
        : []),
      ...(anyShared && can('files.share')
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
                    await copyToClipboard(text);
                    showToast('Link copied', 'success');
                    onActionComplete?.();
                  } catch {
                    // Error handled by toast notification
                    showToast('Failed to copy link', 'error');
                  }
                } catch {
                  // Error handled by toast notification
                  showToast('Failed to load share links', 'error');
                }
              },
            },
          ]
        : []),
      ...(can('files.download')
        ? [
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
          ]
        : []),
      // Open-on-desktop downloads then saves back, so it needs both grants.
      ...(!isTrashView && hasElectronOpenOnDesktop() && singleSelectedItem && can('files.download') && can('files.edit')
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
                  showToast('Failed to open file on desktop', 'error');
                }
              },
            },
          ]
        : []),
      ...(can('files.edit')
        ? [
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
                  showToast('Failed to update star', 'error');
                }
              },
            },
          ]
        : []),
      // Copy duplicates files (an upload); Cut moves them (a modification).
      ...(can('files.upload')
        ? [
            {
              icon: Copy,
              label: 'Copy',
              disabled: false,
              action: () => {
                clipboardCopy(selectedFiles);
                onActionComplete?.();
              },
            },
          ]
        : []),
      ...(can('files.edit')
        ? [
            {
              icon: Scissors,
              label: 'Cut',
              disabled: false,
              action: () => {
                setClipboard({ ids: selectedFiles, action: 'cut' });
                showToast(
                  `Cut ${selectedFiles.length} item${selectedFiles.length !== 1 ? 's' : ''} — paste to move`,
                  'success'
                );
                onActionComplete?.();
              },
            },
          ]
        : []),
      ...(canPaste && (clipboard || electronClipboardAvailable)
        ? [
            {
              icon: ClipboardPaste,
              label: 'Paste',
              disabled: false,
              action: async () => {
                try {
                  await clipboardPaste(targetId ?? folderStack[folderStack.length - 1] ?? null);
                  onActionComplete?.();
                } catch (error) {
                  const errorMessage = error instanceof Error ? error.message : 'Failed to paste files';
                  showToast(errorMessage, 'error');
                }
              },
            },
          ]
        : []),
      {
        icon: Info,
        label: 'Get Info',
        disabled: !singleSelectedItem,
        action: () => {
          if (!singleSelectedItem) return;
          setInfoFile(singleSelectedItem);
          setInfoOpen(true);
        },
      },
      ...(can('files.edit')
        ? [
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
          ]
        : []),
      ...(can('files.delete')
        ? [
            {
              icon: Trash2,
              label: 'Delete',
              disabled: isDeleting,
              action: () => {
                setPendingAction({ type: 'delete', files: selectedFiles });
                setConfirmModalOpen(true);
                onClose();
              },
              danger: true,
            },
          ]
        : []),
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
    clipboardCopy,
    clipboardPaste,
    targetId,
    folderStack,
    files,
    setRenameTarget,
    downloadFiles,
    isDownloading,
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
    isDeleting,
    isRestoring,
    can,
    canPaste,
  ]);

  const confirmationTitle = pendingAction?.type === 'deleteForever' ? 'Delete Forever' : 'Delete';
  const confirmationMessage =
    pendingAction?.type === 'deleteForever'
      ? `Are you sure you want to permanently delete ${pendingAction.files.length} item${pendingAction.files.length !== 1 ? 's' : ''}? This action cannot be undone.`
      : `Are you sure you want to move ${pendingAction?.files.length || 0} item${(pendingAction?.files.length || 0) !== 1 ? 's' : ''} to trash?`;

  return {
    menuItems,
    // Delete confirmation modal
    confirmModalOpen,
    setConfirmModalOpen,
    pendingAction,
    setPendingAction,
    handleConfirmDelete,
    confirmationTitle,
    confirmationMessage,
    isDeleting,
    // Share expiry modal
    shareExpiryOpen,
    setShareExpiryOpen,
    handleShareExpiry,
    selectedFilesCount: selectedFiles.length,
    // Get-info modal
    infoOpen,
    setInfoOpen,
    infoFile,
    currentPath,
  };
}
