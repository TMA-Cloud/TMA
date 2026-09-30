import { useEffect, useRef, useState } from 'react';
import { type BulkUploadEntry, type UploadFailure } from '../AppContext';
import type { PromiseQueue } from '../../utils/debounce';
import { getMaxUploadSizeConfig } from '../../utils/api';
import { ApiError, extractResponseError, extractXhrErrorMessage } from '../../utils/errorUtils';
import {
  createAutoDismissTimeout,
  precheckUploads,
  removeUploadProgress,
  updateUploadProgress,
  type UploadProgressItem,
} from '../../utils/uploadUtils';
import { appendClientMtime } from '../../utils/folderUpload';
import {
  cancelElectronClipboardUpload,
  subscribeToElectronClipboardUploadProgress,
  subscribeToElectronClipboardUploadStatus,
} from '../../utils/electronDesktop';
import { runWithConcurrency, throttleTrailing } from '../../utils/scheduling';
import { formatBytes } from '../../utils/storageUtils';
import { createStore } from '../../utils/store';
import {
  BULK_AGGREGATE_THRESHOLD,
  BULK_BATCH_CONCURRENCY,
  BULK_PROGRESS_THROTTLE_MS,
  describeBulkUpload,
  folderPathOf,
  getInFlightUploadProgress,
  isContentRejection,
  splitIntoBatches,
} from './helpers';

type ToastType = 'success' | 'error' | 'info';

interface UploadsDeps {
  showToast: (message: string, type?: ToastType) => void;
  operationQueue: Pick<PromiseQueue, 'add'>;
  folderStack: (string | null)[];
  refreshFiles: (skipSearchCheck?: boolean) => Promise<void>;
  debouncedRefreshFiles: (...args: unknown[]) => void;
}

/** Upload pipeline (single/bulk/batched/replace) with progress, failures, and cancel. XHR-based for progress. */
export function useUploads({
  showToast,
  operationQueue,
  folderStack,
  refreshFiles,
  debouncedRefreshFiles,
}: UploadsDeps) {
  // Outside React state: progress ticks many times a second and must not
  // re-render the whole app tree, only the progress panel subscribed to it.
  const [uploadProgressStore] = useState(() => createStore<UploadProgressItem[]>([]));
  const setUploadProgress = uploadProgressStore.set;
  const [uploadFailures, setUploadFailures] = useState<UploadFailure[]>([]);
  const [uploadSavedCount, setUploadSavedCount] = useState(0);
  const [isUploadProgressInteracting, setIsUploadProgressInteracting] = useState(false);

  const isUploadProgressInteractingRef = useRef(false);
  const uploadDismissTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const uploadXhrRef = useRef<Map<string, XMLHttpRequest>>(new Map());
  /** Every request belonging to a batched upload, so one Cancel stops all of them. */
  const uploadGroupRef = useRef<Map<string, { xhrs: Set<XMLHttpRequest>; cancelled: boolean }>>(new Map());
  /** Cards backed by an Electron clipboard upload: Cancel has to abort those over IPC. */
  const clipboardUploadIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    isUploadProgressInteractingRef.current = isUploadProgressInteracting;
  }, [isUploadProgressInteracting]);

  /** Append, don't replace: overlapping runs must not erase each other's failures. */
  const reportUploadFailures = (failures: UploadFailure[], savedCount: number) => {
    if (failures.length === 0) return;
    setUploadFailures(prev => [...prev, ...failures]);
    setUploadSavedCount(prev => prev + savedCount);
  };

  /** Pre-flight: per-file size vs max, plus storage headroom. Throws + toasts on failure. */
  const validateUploadSize = async (filesToValidate: File[]): Promise<void> => {
    const { maxBytes } = await getMaxUploadSizeConfig();
    const oversized = filesToValidate.find(f => f.size > maxBytes);
    if (oversized) {
      const msg =
        filesToValidate.length === 1
          ? `This file is too large. Maximum upload size is ${formatBytes(maxBytes)}.`
          : `"${oversized.name}" is too large. Maximum upload size is ${formatBytes(maxBytes)}.`;
      showToast(msg, 'error');
      throw new Error(msg);
    }
    const totalSize = filesToValidate.reduce((sum, f) => sum + f.size, 0);
    try {
      await precheckUploads(totalSize);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Storage limit exceeded.';
      showToast(msg, 'error');
      throw e;
    }
  };

  /** Auto-dismiss a finished card, quicker when it succeeded, never mid-interaction. */
  const scheduleUploadDismiss = (uploadId: string, isSuccess: boolean) => {
    const timeout = isSuccess
      ? createAutoDismissTimeout(
          uploadId,
          isUploadProgressInteractingRef,
          setUploadProgress,
          uploadDismissTimeoutsRef,
          3000,
          2000
        )
      : createAutoDismissTimeout(uploadId, isUploadProgressInteractingRef, setUploadProgress, uploadDismissTimeoutsRef);
    uploadDismissTimeoutsRef.current.set(uploadId, timeout);
  };

  const executeXhrUpload = (config: {
    url: string;
    formData: FormData;
    uploadId: string;
    fileName: string;
    fileSize: number;
    groupId?: string;
    onProgress?: (progress: number) => void;
    /** Takes the reason for callers gathering a failure report. */
    onFailure?: (reason: string) => void;
  }): Promise<void> => {
    const { url, formData, uploadId, fileName, fileSize, groupId, onProgress, onFailure } = config;
    return new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      setUploadProgress(prev => [
        ...prev,
        {
          id: uploadId,
          fileName,
          fileSize,
          progress: 0,
          status: 'uploading' as const,
          ...(groupId ? { groupId } : {}),
        },
      ]);
      uploadXhrRef.current.set(uploadId, xhr);

      xhr.upload.addEventListener('progress', e => {
        if (e.lengthComputable) {
          const progress = getInFlightUploadProgress(e.loaded, e.total);
          // At 99% the browser is waiting on the backend to finalize; show that instead.
          const status: UploadProgressItem['status'] = progress >= 99 ? 'finalizing' : 'uploading';
          setUploadProgress(prev => updateUploadProgress(prev, uploadId, { progress, status }));
          onProgress?.(progress);
        }
      });

      const scheduleAutoDismiss = (isSuccess: boolean) => scheduleUploadDismiss(uploadId, isSuccess);

      const handleError = (fallbackMsg: string) => {
        setUploadProgress(prev => updateUploadProgress(prev, uploadId, { status: 'error' }));
        const errorMessage = extractXhrErrorMessage(xhr) || fallbackMsg;
        if (onFailure) onFailure(errorMessage);
        else showToast(errorMessage, 'error');
        scheduleAutoDismiss(false);
        uploadXhrRef.current.delete(uploadId);
        reject(new Error(errorMessage));
      };

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          setUploadProgress(prev => updateUploadProgress(prev, uploadId, { progress: 100, status: 'completed' }));
          debouncedRefreshFiles(false);
          scheduleAutoDismiss(true);
          uploadXhrRef.current.delete(uploadId);
          resolve();
        } else {
          handleError('Upload failed');
        }
      });

      xhr.addEventListener('error', () => handleError('Upload failed. Please check your connection and try again.'));

      xhr.addEventListener('abort', () => {
        setUploadProgress(prev => removeUploadProgress(prev, uploadId));
        uploadXhrRef.current.delete(uploadId);
        reject(new Error('Upload cancelled'));
      });

      xhr.open('POST', url);
      xhr.withCredentials = true;
      xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
      xhr.send(formData);
    });
  };

  // Upload dismiss effect

  useEffect(() => {
    if (!isUploadProgressInteracting) {
      const checkTimeout = setTimeout(() => {
        if (!isUploadProgressInteractingRef.current) {
          setUploadProgress(prev =>
            prev.filter(item => {
              if (item.status === 'completed' || item.status === 'error') {
                const t = uploadDismissTimeoutsRef.current.get(item.id);
                if (t) {
                  clearTimeout(t);
                  uploadDismissTimeoutsRef.current.delete(item.id);
                }
                return false;
              }
              return true;
            })
          );
        }
      }, 2000);
      return () => clearTimeout(checkTimeout);
    } else {
      uploadDismissTimeoutsRef.current.forEach(t => clearTimeout(t));
      uploadDismissTimeoutsRef.current.clear();
    }
  }, [isUploadProgressInteracting, setUploadProgress]);

  // A clipboard paste uploads in Electron's main process, so there is no XHR
  // here to hang progress off; these two subscriptions feed the same cards.
  useEffect(() => {
    const stopStatus = subscribeToElectronClipboardUploadStatus(payload => {
      // End of a paste: the reasons belong in the same dialog a bulk upload fills.
      if (payload.state === 'finished') {
        if (payload.failed.length > 0) reportUploadFailures(payload.failed, payload.saved);
        return;
      }

      const { id } = payload;
      if (!id) return;

      if (payload.state === 'started') {
        clipboardUploadIdsRef.current.add(id);
        setUploadProgress(prev => [
          ...prev.filter(item => item.id !== id),
          { id, fileName: payload.fileName, fileSize: payload.fileSize ?? 0, progress: 0, status: 'uploading' },
        ]);
        return;
      }

      clipboardUploadIdsRef.current.delete(id);
      if (payload.state === 'completed') {
        setUploadProgress(prev => updateUploadProgress(prev, id, { progress: 100, status: 'completed' }));
        debouncedRefreshFiles(false);
      } else {
        setUploadProgress(prev => updateUploadProgress(prev, id, { status: 'error' }));
      }
      scheduleUploadDismiss(id, payload.state === 'completed');
    });

    const stopProgress = subscribeToElectronClipboardUploadProgress(({ id, loaded, total }) => {
      if (!(total > 0)) return;
      const progress = getInFlightUploadProgress(loaded, total);
      // At 99% the bytes are sent and the backend is finalizing; say so.
      const status: UploadProgressItem['status'] = progress >= 99 ? 'finalizing' : 'uploading';
      setUploadProgress(prev => {
        const item = prev.find(entry => entry.id === id);
        if (!item || (item.status !== 'uploading' && item.status !== 'finalizing')) return prev;
        return updateUploadProgress(prev, id, { progress, status });
      });
    });

    return () => {
      stopStatus();
      stopProgress();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const uploadFile = async (file: File) => {
    return operationQueue.add(async () => {
      await validateUploadSize([file]);
      const data = new FormData();
      const parentId = folderStack[folderStack.length - 1];
      if (parentId) data.append('parentId', parentId);
      data.append('file', file);
      const res = await fetch('/api/files/upload', {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-Requested-With': 'XMLHttpRequest' },
        body: data,
      });
      if (!res.ok) {
        // Report to the dialog; the sole caller walks away, so a throw lands nowhere.
        reportUploadFailures([{ fileName: file.name, reason: await extractResponseError(res) }], 0);
        return;
      }
      await refreshFiles();
    });
  };

  const uploadFilesBulk = async (filesToUpload: File[]) => {
    return uploadEntriesBulk(filesToUpload.map(file => ({ file })));
  };

  /**
   * Uploads a set of files as a sequence of bounded batches.
   */
  const uploadEntriesBulk = async (allEntries: BulkUploadEntry[]) => {
    if (allEntries.length === 0) return;

    return operationQueue.add(async () => {
      await validateUploadSize(allEntries.map(e => e.file));
      const entries = allEntries;

      const parentId = folderStack[folderStack.length - 1];
      const hasRelativePaths = entries.some(e => e.relativePath);

      // A few loose files stay per-file: a row each and independent cancel beat batching.
      if (!hasRelativePaths && entries.length <= BULK_AGGREGATE_THRESHOLD) {
        const rejected: UploadFailure[] = [];
        await runWithConcurrency(entries, BULK_BATCH_CONCURRENCY, (entry, index) => {
          const clientId = entry.clientId || `file-${Date.now()}-${index}`;
          const formData = new FormData();
          if (parentId) formData.append('parentId', parentId);
          formData.append('files', entry.file);
          formData.append('clientIds', clientId);
          appendClientMtime(formData, entry.file);

          return executeXhrUpload({
            url: '/api/files/upload/bulk',
            formData,
            uploadId: clientId,
            fileName: entry.file.name,
            fileSize: entry.file.size,
            // Swallowed, not thrown: one refused file must not stop the rest.
            onFailure: reason => rejected.push({ fileName: entry.file.name, reason }),
          }).catch(() => {});
        });
        if (rejected.length > 0) reportUploadFailures(rejected, entries.length - rejected.length);
        return;
      }

      const groupId = `bulk-${Date.now()}-${Math.random()}`;
      const aggregateId = `${groupId}-all`;
      const normalized = entries.map((entry, i) => ({
        file: entry.file,
        clientId: entry.clientId || `${groupId}-${i}`,
        relativePath: entry.relativePath || '',
      }));
      const totalBytes = Math.max(
        1,
        normalized.reduce((sum, e) => sum + e.file.size, 0)
      );
      const batches = splitIntoBatches(normalized);

      const group = { xhrs: new Set<XMLHttpRequest>(), cancelled: false };
      uploadGroupRef.current.set(groupId, group);
      uploadGroupRef.current.set(aggregateId, group);

      setUploadProgress(prev => [
        ...prev,
        {
          id: aggregateId,
          fileName: describeBulkUpload(normalized),
          fileSize: totalBytes,
          progress: 0,
          status: 'uploading' as const,
          groupId,
        },
      ]);

      const sentBytes = new Array<number>(batches.length).fill(0);
      const rejected: UploadFailure[] = [];
      let completedFiles = 0;
      let settled = false;

      const publishProgress = throttleTrailing(() => {
        if (settled) return;
        const loaded = sentBytes.reduce((sum, n) => sum + n, 0);
        const progress = getInFlightUploadProgress(loaded, totalBytes);
        // The tail of the run is server write time; show "finalizing" not a stuck 99%.
        const status: UploadProgressItem['status'] = progress >= 99 ? 'finalizing' : 'uploading';
        setUploadProgress(prev => updateUploadProgress(prev, aggregateId, { progress, status }));
      }, BULK_PROGRESS_THROTTLE_MS);

      const scheduleAggregateDismiss = (isSuccess: boolean) => scheduleUploadDismiss(aggregateId, isSuccess);

      const sendBatch = (batch: typeof normalized, batchIndex: number) =>
        new Promise<void>((resolve, reject) => {
          if (group.cancelled) {
            resolve();
            return;
          }

          const batchBytes = batch.reduce((sum, e) => sum + e.file.size, 0);
          const data = new FormData();
          if (parentId) data.append('parentId', parentId);
          batch.forEach(entry => {
            data.append('files', entry.file);
            data.append('relativePaths', entry.relativePath);
            data.append('clientIds', entry.clientId);
            appendClientMtime(data, entry.file);
          });

          const xhr = new XMLHttpRequest();
          group.xhrs.add(xhr);
          const release = () => group.xhrs.delete(xhr);

          xhr.upload.addEventListener('progress', e => {
            if (!e.lengthComputable || e.total === 0) return;
            // Scale to file bytes: the multipart envelope inflates e.total.
            sentBytes[batchIndex] = Math.min(batchBytes, (e.loaded / e.total) * batchBytes);
            publishProgress();
          });

          xhr.addEventListener('load', () => {
            release();
            if (xhr.status < 200 || xhr.status >= 300) {
              const message = extractXhrErrorMessage(xhr) || 'Failed to upload files';
              // A content rejection is per-batch, so later batches still go; anything
              // else (signed out, out of quota, server down) will refuse them all.
              if (!isContentRejection(xhr.status)) {
                reject(new Error(message));
                return;
              }
              sentBytes[batchIndex] = batchBytes;
              batch.forEach(entry => {
                const folder = folderPathOf(entry.relativePath);
                rejected.push({
                  fileName: entry.file.name,
                  reason: message,
                  ...(folder ? { folderPath: folder } : {}),
                });
              });
              publishProgress();
              resolve();
              return;
            }

            sentBytes[batchIndex] = batchBytes;
            let succeeded = batch.length;
            let failures: { fileName: string; error: string; clientId?: string }[] = [];
            try {
              const response = JSON.parse(xhr.responseText);
              if (Array.isArray(response?.files)) succeeded = response.files.length;
              if (Array.isArray(response?.failed)) failures = response.failed;
            } catch {
              // Unparseable body on a 2xx: count the batch as delivered.
            }

            completedFiles += succeeded;
            // Held for the end-of-run dialog; the client id ties a rejection to its folder.
            failures.forEach(f => {
              const entry = batch.find(e => e.clientId === f.clientId);
              const folder = folderPathOf(entry?.relativePath);
              rejected.push({ fileName: f.fileName, reason: f.error, ...(folder ? { folderPath: folder } : {}) });
            });

            publishProgress();
            // Each landed batch is real, visible progress in the file list.
            debouncedRefreshFiles(false);
            resolve();
          });

          xhr.addEventListener('error', () => {
            release();
            reject(
              new Error(extractXhrErrorMessage(xhr) || 'Upload failed. Please check your connection and try again.')
            );
          });

          // An abort here is the cancelled group tearing down, not a failure.
          xhr.addEventListener('abort', () => {
            release();
            resolve();
          });

          xhr.open('POST', '/api/files/upload/bulk');
          xhr.withCredentials = true;
          xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
          xhr.send(data);
        });

      try {
        if (hasRelativePaths) {
          for (let i = 0; i < batches.length; i++) {
            if (group.cancelled) break;
            await sendBatch(batches[i] as typeof normalized, i);
          }
        } else {
          await runWithConcurrency(batches, BULK_BATCH_CONCURRENCY, (batch, i) =>
            group.cancelled ? Promise.resolve() : sendBatch(batch, i)
          );
        }

        settled = true;
        if (group.cancelled) return;

        const allFailed = completedFiles === 0 && rejected.length > 0;
        setUploadProgress(prev =>
          updateUploadProgress(prev, aggregateId, {
            progress: 100,
            status: allFailed ? 'error' : 'completed',
          })
        );
        // The card already carries the counts; the dialog carries the reasons.
        if (rejected.length > 0) reportUploadFailures(rejected, completedFiles);
        scheduleAggregateDismiss(!allFailed);
        debouncedRefreshFiles(false);
      } catch (err) {
        settled = true;
        setUploadProgress(prev => updateUploadProgress(prev, aggregateId, { status: 'error' }));
        showToast(err instanceof Error ? err.message : 'Failed to upload files', 'error');
        scheduleAggregateDismiss(false);
        debouncedRefreshFiles(false);
        throw err;
      } finally {
        group.xhrs.forEach(xhr => xhr.abort());
        uploadGroupRef.current.delete(groupId);
        uploadGroupRef.current.delete(aggregateId);
      }
    });
  };

  const uploadFileWithProgress = async (file: File, onProgress?: (progress: number) => void) => {
    return operationQueue.add(async () => {
      await validateUploadSize([file]);
      const formData = new FormData();
      const parentId = folderStack[folderStack.length - 1];
      if (parentId) formData.append('parentId', parentId);
      formData.append('file', file);
      appendClientMtime(formData, file);
      return executeXhrUpload({
        url: '/api/files/upload',
        formData,
        uploadId: `${Date.now()}-${Math.random()}`,
        fileName: file.name,
        fileSize: file.size,
        onProgress,
        // Dialog, not a toast: it names the file and waits to be read.
        onFailure: reason => reportUploadFailures([{ fileName: file.name, reason }], 0),
      });
    });
  };

  const replaceFileWithProgress = async (fileId: string, file: File, onProgress?: (progress: number) => void) => {
    return operationQueue.add(async () => {
      await validateUploadSize([file]);
      const formData = new FormData();
      formData.append('file', file);
      appendClientMtime(formData, file);
      return executeXhrUpload({
        url: `/api/files/${fileId}/replace`,
        formData,
        uploadId: `${Date.now()}-${Math.random()}`,
        fileName: file.name,
        fileSize: file.size,
        onProgress,
        onFailure: reason => reportUploadFailures([{ fileName: file.name, reason }], 0),
      });
    });
  };

  /** Stops a batched upload: no further batch is sent, in-flight ones abort; landed batches stay. */
  const cancelUploadBatchGroup = (key: string): boolean => {
    const group = uploadGroupRef.current.get(key);
    if (!group) return false;
    group.cancelled = true;
    group.xhrs.forEach(xhr => xhr.abort());
    group.xhrs.clear();
    return true;
  };

  const cancelUpload = (uploadId: string) => {
    // Clipboard uploads stream from the main process; abort them over IPC.
    if (clipboardUploadIdsRef.current.delete(uploadId)) {
      void cancelElectronClipboardUpload(uploadId);
      setUploadProgress(prev => removeUploadProgress(prev, uploadId));
      debouncedRefreshFiles(true);
      return;
    }
    if (cancelUploadBatchGroup(uploadId)) {
      setUploadProgress(prev => removeUploadProgress(prev, uploadId));
      debouncedRefreshFiles(true);
      return;
    }
    const xhr = uploadXhrRef.current.get(uploadId);
    if (xhr) {
      xhr.abort();
      setUploadProgress(prev => removeUploadProgress(prev, uploadId));
      uploadXhrRef.current.delete(uploadId);
      return;
    }
    setUploadProgress(prev => removeUploadProgress(prev, uploadId));
  };

  const cancelUploadGroup = (groupId: string) => {
    cancelUploadBatchGroup(groupId);
    const idsToCancel = uploadProgressStore
      .get()
      .filter(item => item.groupId === groupId)
      .map(item => item.id);
    if (idsToCancel.length === 0) return;
    idsToCancel.forEach(id => {
      const xhr = uploadXhrRef.current.get(id);
      if (xhr) {
        xhr.abort();
        uploadXhrRef.current.delete(id);
      }
      setUploadProgress(prev => removeUploadProgress(prev, id));
    });
    debouncedRefreshFiles(true);
  };

  return {
    uploadProgressStore,
    setUploadProgress,
    uploadFailures,
    uploadSavedCount,
    dismissUploadFailures: () => {
      setUploadFailures([]);
      setUploadSavedCount(0);
    },
    setIsUploadProgressInteracting,
    validateUploadSize,
    reportUploadFailures,
    uploadFile,
    uploadFilesBulk,
    uploadEntriesBulk,
    uploadFileWithProgress,
    replaceFileWithProgress,
    cancelUpload,
    cancelUploadGroup,
  };
}
