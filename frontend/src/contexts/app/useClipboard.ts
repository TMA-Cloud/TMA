import { useEffect, useRef, useState } from 'react';
import { type FileItem } from '../AppContext';
import type { PromiseQueue } from '../../utils/debounce';
import { extractResponseError } from '../../utils/errorUtils';
import {
  copyFilesToPcClipboard,
  getFilesFromElectronClipboard,
  isElectron,
  MAX_COPY_TO_PC_BYTES,
  peekElectronClipboardFileNames,
} from '../../utils/electronDesktop';

type ToastType = 'success' | 'error' | 'info';

interface ClipboardDeps {
  showToast: (message: string, type?: ToastType) => void;
  operationQueue: Pick<PromiseQueue, 'add'>;
  files: FileItem[];
  refreshFiles: (skipSearchCheck?: boolean) => Promise<void>;
  uploadFilesBulk: (files: File[]) => Promise<void>;
}

/** Unified clipboard: an in-app cloud clipboard, mirrored best-effort to the OS clipboard in Electron. */
export function useClipboard({ showToast, operationQueue, files, refreshFiles, uploadFilesBulk }: ClipboardDeps) {
  const [clipboard, setClipboard] = useState<{ ids: string[]; action: 'copy' | 'cut' } | null>(null);
  const [pasteProgress, setPasteProgress] = useState<number | null>(null);

  /** Names we last synced to the OS clipboard, so paste can detect an external overwrite. */
  const lastOsClipboardSyncRef = useRef<string[] | null>(null);

  // Any non-Copy clipboard change invalidates the OS sync tracker.
  useEffect(() => {
    if (!clipboard || clipboard.action !== 'copy') {
      lastOsClipboardSyncRef.current = null;
    }
  }, [clipboard]);

  /** Sets the cloud clipboard, then best-effort syncs eligible files to the OS clipboard in Electron. */
  const clipboardCopy = (ids: string[]) => {
    if (ids.length === 0) return;

    setClipboard({ ids, action: 'copy' });
    // Reset tracker — populated below only if we actually sync to the OS clipboard.
    lastOsClipboardSyncRef.current = null;

    const itemCount = ids.length;
    const itemLabel = `${itemCount} item${itemCount !== 1 ? 's' : ''}`;

    if (!isElectron()) {
      showToast(`Copied ${itemLabel}`, 'success');
      return;
    }

    const fileItems = ids
      .map(id => files.find(f => f.id === id))
      .filter((f): f is FileItem => f != null && String(f.type || '').toLowerCase() !== 'folder');
    const folderCount = itemCount - fileItems.length;
    const totalBytes = fileItems.reduce((s, f) => s + Number(f.size ?? 0), 0);
    const overLimit =
      fileItems.some(f => f.size != null && Number(f.size) > MAX_COPY_TO_PC_BYTES) || totalBytes > MAX_COPY_TO_PC_BYTES;

    if (fileItems.length === 0) {
      // Folders only — cloud paste only.
      showToast(`Copied ${itemLabel} (folders paste in cloud only)`, 'success');
      return;
    }
    if (overLimit) {
      showToast(`Copied ${itemLabel} (over 200 MB — paste in cloud only)`, 'success');
      return;
    }

    const items = fileItems.map(f => ({ id: f.id, name: f.name }));
    copyFilesToPcClipboard(items)
      .then(result => {
        if (result.ok) {
          // Remember the synced names so a later paste can detect an external overwrite.
          lastOsClipboardSyncRef.current = items.map(i => i.name);
          const folderNote =
            folderCount > 0 ? ` (${folderCount} folder${folderCount !== 1 ? 's' : ''} cloud-only)` : '';
          showToast(`Copied ${itemLabel}${folderNote} — paste in cloud or in Explorer`, 'success');
        } else {
          showToast(`Copied ${itemLabel} (system clipboard unavailable — paste in cloud)`, 'success');
        }
      })
      .catch(() => {
        showToast(`Copied ${itemLabel} (system clipboard error — paste in cloud)`, 'success');
      });
  };

  const pasteClipboard = async (parentId: string | null) => {
    if (!clipboard) return;

    return operationQueue.add(async () => {
      setPasteProgress(0);
      const endpoint = clipboard.action === 'cut' ? 'move' : 'copy';

      try {
        const res = await fetch(`/api/files/${endpoint}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          credentials: 'include',
          body: JSON.stringify({ ids: clipboard.ids, parentId }),
        });

        if (!res.ok) {
          const errorMessage = await extractResponseError(res);
          throw new Error(
            errorMessage || (clipboard.action === 'cut' ? 'Failed to move files' : 'Failed to copy files')
          );
        }

        setPasteProgress(100);
        await refreshFiles();
        setClipboard(null);
        setTimeout(() => setPasteProgress(null), 300);
      } catch (error) {
        setPasteProgress(null);
        throw error;
      }
    });
  };

  /** Paste: cloud clipboard first (no re-upload); fall back to uploading the OS clipboard. */
  const clipboardPaste = async (parentId: string | null) => {
    // No cloud clipboard: only the OS clipboard matters.
    if (!clipboard) {
      if (!isElectron()) {
        showToast('Nothing to paste', 'info');
        return;
      }
      const clipFiles = await getFilesFromElectronClipboard();
      if (clipFiles.length === 0) {
        showToast('Nothing to paste', 'info');
        return;
      }
      await uploadFilesBulk(clipFiles);
      return;
    }

    // If the OS clipboard was overwritten externally since our sync, upload that instead.
    // Cut is exempt: its OS clipboard is never synced, so anything there is unrelated.
    if (isElectron() && clipboard.action === 'copy') {
      const osNames = await peekElectronClipboardFileNames();
      const synced = lastOsClipboardSyncRef.current;
      const osHasFiles = osNames.length > 0;
      const matchesSync =
        synced != null &&
        osNames.length === synced.length &&
        new Set(synced).size === synced.length &&
        osNames.every(n => synced.includes(n));

      if (osHasFiles && !matchesSync) {
        // OS clipboard was set after our cloud copy (or we never synced). Treat as external paste.
        const clipFiles = await getFilesFromElectronClipboard();
        if (clipFiles.length > 0) {
          // Drop the now-stale cloud clipboard so subsequent pastes don't re-trigger this branch.
          setClipboard(null);
          await uploadFilesBulk(clipFiles);
          return;
        }
        // Peek saw names but readFiles returned nothing; fall through to cloud paste.
      }
    }

    await pasteClipboard(parentId);
  };

  return {
    clipboard,
    setClipboard,
    clipboardCopy,
    clipboardPaste,
    pasteProgress,
    setPasteProgress,
  };
}
