import { useState } from 'react';
import { type FileItem } from '../AppContext';
import {
  claimElectronClipboard,
  copyFilesToPcClipboard,
  hasExternalElectronClipboardFiles,
  isElectron,
  MAX_COPY_TO_PC_BYTES,
  uploadElectronClipboardFiles,
} from '../../utils/electronDesktop';
import { choosePasteSource, type CloudClipboard } from './helpers';

type ToastType = 'success' | 'error' | 'info';

interface ClipboardDeps {
  showToast: (message: string, type?: ToastType) => void;
  files: FileItem[];
  refreshFiles: (skipSearchCheck?: boolean) => Promise<void>;
  /** Server-side move and copy; copy waits for its background job to finish. */
  moveFiles: (ids: string[], parentId: string | null) => Promise<void>;
  copyFiles: (ids: string[], parentId: string | null) => Promise<void>;
}

const itemLabel = (count: number) => `${count} item${count !== 1 ? 's' : ''}`;

/**
 * Unified clipboard: an in-app cloud clipboard plus the OS clipboard in Electron.
 * Like Windows, the most recent Copy or Cut anywhere owns the clipboard: an
 * in-app Copy or Cut claims the OS clipboard, so OS files found at paste time
 * are newer and win. A copy can be pasted repeatedly; a cut is spent on paste.
 */
export function useClipboard({ showToast, files, refreshFiles, moveFiles, copyFiles }: ClipboardDeps) {
  const [clipboard, setClipboard] = useState<CloudClipboard | null>(null);
  const [pasteProgress, setPasteProgress] = useState<number | null>(null);

  const namesOf = (ids: string[]) => ids.map(id => files.find(f => f.id === id)?.name).filter((n): n is string => !!n);

  /** Sets the cloud clipboard, then best-effort syncs eligible files to the OS clipboard in Electron. */
  const clipboardCopy = (ids: string[]) => {
    if (ids.length === 0) return;

    setClipboard({ ids, action: 'copy' });
    const label = itemLabel(ids.length);

    if (!isElectron()) {
      showToast(`Copied ${label}`, 'success');
      return;
    }

    const fileItems = ids
      .map(id => files.find(f => f.id === id))
      .filter((f): f is FileItem => f != null && String(f.type || '').toLowerCase() !== 'folder');
    const folderCount = ids.length - fileItems.length;
    const totalBytes = fileItems.reduce((s, f) => s + Number(f.size ?? 0), 0);
    const overLimit =
      fileItems.some(f => f.size != null && Number(f.size) > MAX_COPY_TO_PC_BYTES) || totalBytes > MAX_COPY_TO_PC_BYTES;

    if (fileItems.length === 0 || overLimit) {
      void claimElectronClipboard(namesOf(ids));
      const note = fileItems.length === 0 ? 'folders paste in cloud only' : 'over 200 MB — paste in cloud only';
      showToast(`Copied ${label} (${note})`, 'success');
      return;
    }

    copyFilesToPcClipboard(fileItems.map(f => ({ id: f.id, name: f.name })))
      .then(result => {
        if (result.ok) {
          const folderNote =
            folderCount > 0 ? ` (${folderCount} folder${folderCount !== 1 ? 's' : ''} cloud-only)` : '';
          showToast(`Copied ${label}${folderNote} — paste in cloud or in Explorer`, 'success');
        } else if (!result.superseded) {
          showToast(`Copied ${label} (system clipboard unavailable — paste in cloud)`, 'success');
        }
      })
      .catch(() => {
        showToast(`Copied ${label} (system clipboard error — paste in cloud)`, 'success');
      });
  };

  /** Marks items to move on the next paste. Cut is cloud-only, but still takes the OS clipboard. */
  const clipboardCut = (ids: string[]) => {
    if (ids.length === 0) return;
    setClipboard({ ids, action: 'cut' });
    void claimElectronClipboard(namesOf(ids));
    showToast(`Cut ${itemLabel(ids.length)} — paste to move`, 'success');
  };

  const pasteCloudClipboard = async (clip: CloudClipboard, parentId: string | null) => {
    setPasteProgress(0);
    try {
      if (clip.action === 'cut') {
        await moveFiles(clip.ids, parentId);
        // A cut is spent once moved; a newer Copy or Cut made meanwhile stays.
        setClipboard(current => (current === clip ? null : current));
      } else {
        await copyFiles(clip.ids, parentId);
      }
      setPasteProgress(100);
      setTimeout(() => setPasteProgress(null), 300);
    } catch (error) {
      setPasteProgress(null);
      throw error;
    }
  };

  /** Uploads the OS clipboard; returns false when it held nothing to upload. */
  const pasteOsClipboard = async (parentId: string | null) => {
    const direct = await uploadElectronClipboardFiles(parentId);
    if (direct.ok) {
      await refreshFiles();
      return true;
    }
    if (!direct.fallback) throw new Error(direct.error || 'Clipboard upload failed');
    return false;
  };

  /** Paste whichever clipboard is newer: files copied in another app, else the cloud clipboard. */
  const clipboardPaste = async (parentId: string | null) => {
    const clip = clipboard;
    const osHasExternalFiles = clip != null && (await hasExternalElectronClipboardFiles());
    const source = choosePasteSource({ cloud: clip, electron: isElectron(), osHasExternalFiles });

    if (source === 'os' && (await pasteOsClipboard(parentId))) {
      // A newer copy elsewhere replaced ours, as it would in Explorer.
      if (clip) setClipboard(current => (current === clip ? null : current));
      return;
    }
    if (!clip) {
      showToast('Nothing to paste', 'info');
      return;
    }
    await pasteCloudClipboard(clip, parentId);
  };

  return {
    clipboard,
    setClipboard,
    clipboardCopy,
    clipboardCut,
    clipboardPaste,
    pasteProgress,
    setPasteProgress,
  };
}
