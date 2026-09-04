import { useEffect, useRef, useState } from 'react';
import { type FileItem } from '../AppContext';
import { downloadFile as downloadFileApi } from '../../utils/api';
import { downloadBlob, streamResponseToBlob } from '../../utils/download';
import { extractResponseError } from '../../utils/errorUtils';
import {
  isElectron,
  saveFileViaElectron,
  saveFilesBulkViaElectron,
  subscribeToElectronSaveProgress,
} from '../../utils/electronDesktop';
import {
  createTransferAutoDismiss,
  removeTransfer,
  updateTransfer,
  type TransferItem,
  type TransferStatus,
} from '../../utils/transferUtils';
import { parseContentDispositionFilename } from './helpers';

type ToastType = 'success' | 'error' | 'info';

interface DownloadsDeps {
  showToast: (message: string, type?: ToastType) => void;
  files: FileItem[];
}

const isInFlight = (s: TransferStatus) =>
  s === 'downloading' || s === 'zipping' || s === 'uploading' || s === 'finalizing';

/**
 * Download pipeline with per-file progress cards (shared with uploads).
 *
 * Web downloads stream the response body so the bar tracks real bytes; a bulk or
 * folder ZIP has no Content-Length, so it shows an indeterminate "zipping →
 * downloading" bar. Electron saves go through the desktop bridge, which reports
 * no byte progress, so those show a styled indeterminate card.
 */
export function useDownloads({ showToast, files }: DownloadsDeps) {
  const [downloadProgress, setDownloadProgress] = useState<TransferItem[]>([]);
  const [isDownloadProgressInteracting, setIsDownloadProgressInteracting] = useState(false);

  const isInteractingRef = useRef(false);
  const dismissTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const abortRef = useRef<Map<string, AbortController>>(new Map());
  /** Coalesce a double-click on the same selection into one download. */
  const activeSignaturesRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    isInteractingRef.current = isDownloadProgressInteracting;
  }, [isDownloadProgressInteracting]);

  // Sweep finished cards once the user stops interacting, mirroring uploads.
  useEffect(() => {
    if (isDownloadProgressInteracting) {
      dismissTimeoutsRef.current.forEach(t => clearTimeout(t));
      dismissTimeoutsRef.current.clear();
      return;
    }
    const checkTimeout = setTimeout(() => {
      if (!isInteractingRef.current) {
        setDownloadProgress(prev =>
          prev.filter(item => {
            if (item.status === 'completed' || item.status === 'error') {
              const t = dismissTimeoutsRef.current.get(item.id);
              if (t) {
                clearTimeout(t);
                dismissTimeoutsRef.current.delete(item.id);
              }
              return false;
            }
            return true;
          })
        );
      }
    }, 2000);
    return () => clearTimeout(checkTimeout);
  }, [isDownloadProgressInteracting]);

  // Electron saves stream over IPC; reflect their real byte progress on the card.
  useEffect(() => {
    return subscribeToElectronSaveProgress(({ id, loaded, total }) => {
      setDownloadProgress(prev =>
        prev.map(item => {
          if (item.id !== id || item.status === 'completed' || item.status === 'error') return item;
          return {
            ...item,
            status: 'downloading',
            indeterminate: !(total > 0),
            progress: total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : item.progress,
          };
        })
      );
    });
  }, []);

  const isDownloading = downloadProgress.some(item => isInFlight(item.status));

  const patch = (id: string, updates: Partial<TransferItem>) =>
    setDownloadProgress(prev => updateTransfer(prev, id, updates));

  const scheduleDismiss = (id: string, success: boolean) => {
    const timeout = success
      ? createTransferAutoDismiss(id, isInteractingRef, setDownloadProgress, dismissTimeoutsRef, 3000, 2000)
      : createTransferAutoDismiss(id, isInteractingRef, setDownloadProgress, dismissTimeoutsRef);
    dismissTimeoutsRef.current.set(id, timeout);
  };

  const dismissDownload = (id: string) => setDownloadProgress(prev => removeTransfer(prev, id));

  const cancelDownload = (id: string) => {
    const controller = abortRef.current.get(id);
    if (controller) controller.abort();
    abortRef.current.delete(id);
    setDownloadProgress(prev => removeTransfer(prev, id));
  };

  /** Turn streamed bytes into card updates: first byte flips zipping→downloading. */
  const onStreamProgress = (id: string, isZip: boolean) => (loaded: number, total: number | null) => {
    if (total && total > 0) {
      patch(id, {
        status: 'downloading',
        indeterminate: false,
        progress: Math.min(100, Math.round((loaded / total) * 100)),
      });
    } else {
      // No length: keep the bar animated, but leave "zipping" until bytes actually flow.
      patch(id, { status: isZip && loaded === 0 ? 'zipping' : 'downloading', indeterminate: true });
    }
  };

  const runWebDownload = async (id: string, item: TransferItem, run: (signal: AbortSignal) => Promise<void>) => {
    const controller = new AbortController();
    abortRef.current.set(id, controller);
    setDownloadProgress(prev => [...prev, item]);
    try {
      await run(controller.signal);
      patch(id, { status: 'completed', progress: 100, indeterminate: false });
      scheduleDismiss(id, true);
    } catch (error) {
      if (controller.signal.aborted) {
        setDownloadProgress(prev => removeTransfer(prev, id));
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      patch(id, { status: 'error' });
      scheduleDismiss(id, false);
      showToast(message || 'Failed to download files', 'error');
    } finally {
      abortRef.current.delete(id);
    }
  };

  const downloadViaElectron = async (id: string, item: TransferItem, ids: string[]) => {
    setDownloadProgress(prev => [...prev, item]);
    try {
      const result =
        ids.length > 1
          ? await saveFilesBulkViaElectron(ids, id)
          : await saveFileViaElectron({
              fileId: ids[0] as string,
              suggestedFileName: item.fileName,
              downloadId: id,
            });
      if (result.ok) {
        patch(id, { status: 'completed', progress: 100, indeterminate: false });
        scheduleDismiss(id, true);
      } else if (result.canceled) {
        setDownloadProgress(prev => removeTransfer(prev, id));
      } else {
        patch(id, { status: 'error' });
        scheduleDismiss(id, false);
        if (result.error) showToast(result.error, 'error');
      }
    } catch (error) {
      patch(id, { status: 'error' });
      scheduleDismiss(id, false);
      showToast(error instanceof Error ? error.message : 'Failed to save files', 'error');
    }
  };

  const downloadFiles = async (ids: string[]) => {
    if (ids.length === 0) return;
    const signature = [...ids].sort().join(',');
    if (activeSignaturesRef.current.has(signature)) return;
    activeSignaturesRef.current.add(signature);

    const id = `download-${Date.now()}-${Math.random()}`;
    const firstId = ids[0] as string;
    const firstFile = files.find(f => f.id === firstId);
    const isBulk = ids.length > 1;
    const isFolder = firstFile?.type === 'folder';
    const isZip = isBulk || isFolder;

    const baseName = firstFile?.name || (isFolder ? 'folder' : 'file');
    const fileName = isBulk ? `${ids.length} items` : isFolder ? `${baseName}.zip` : baseName;
    // Electron saves report no byte progress over IPC, so those bars stay
    // indeterminate; on the web only a single known file gets a determinate bar
    // (ZIPs are streamed without a Content-Length).
    const electron = isElectron();
    const indeterminate = electron || isZip;
    const fileSize = !indeterminate && firstFile?.size ? firstFile.size : 0;

    const item: TransferItem = {
      id,
      fileName,
      fileSize,
      progress: 0,
      status: isZip ? 'zipping' : 'downloading',
      indeterminate,
    };

    try {
      if (isElectron()) {
        await downloadViaElectron(id, item, ids);
        return;
      }

      if (isBulk) {
        await runWebDownload(id, item, async signal => {
          const res = await fetch('/api/files/download/bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            credentials: 'include',
            body: JSON.stringify({ ids }),
            signal,
          });
          if (!res.ok) throw new Error((await extractResponseError(res)) || 'Failed to download files');
          const filename = parseContentDispositionFilename(
            res.headers.get('Content-Disposition'),
            `download_${Date.now()}.zip`
          );
          const blob = await streamResponseToBlob(res, onStreamProgress(id, true));
          downloadBlob(blob, filename);
        });
      } else {
        await runWebDownload(id, item, async signal => {
          await downloadFileApi(firstId, fileName, onStreamProgress(id, isZip), signal);
        });
      }
    } finally {
      activeSignaturesRef.current.delete(signature);
    }
  };

  return {
    isDownloading,
    downloadFiles,
    downloadProgress,
    cancelDownload,
    dismissDownload,
    setIsDownloadProgressInteracting,
  };
}
