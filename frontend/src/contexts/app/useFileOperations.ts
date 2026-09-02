import { useRef, useState } from 'react';
import { type FileItemResponse, type ShareExpiry } from '../AppContext';
import type { PromiseQueue } from '../../utils/debounce';
import { extractResponseError } from '../../utils/errorUtils';
import type { ProgressState } from './helpers';

type ToastType = 'success' | 'error' | 'info';

interface FileOperationsDeps {
  showToast: (message: string, type?: ToastType) => void;
  operationQueue: Pick<PromiseQueue, 'add'>;
  folderStack: (string | null)[];
  refreshFiles: (skipSearchCheck?: boolean) => Promise<void>;
  refreshOrResearch: () => Promise<void>;
}

/** File mutations: create/move/copy/rename/share/star and the trash lifecycle. */
export function useFileOperations({
  showToast,
  operationQueue,
  folderStack,
  refreshFiles,
  refreshOrResearch,
}: FileOperationsDeps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState<ProgressState | null>(null);
  const [restoreProgress, setRestoreProgress] = useState<ProgressState | null>(null);

  const deleteInProgressRef = useRef(false);
  const deleteProgressDismissTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restoreInProgressRef = useRef(false);
  const restoreProgressDismissTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runProgressOperation = async (opts: {
    ids: string[];
    lockRef: React.MutableRefObject<boolean>;
    dismissRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
    setActive: (v: boolean) => void;
    setProgress: React.Dispatch<React.SetStateAction<ProgressState | null>>;
    actionLabel: string;
    finalizeLabel: string;
    url: string;
    onFetch?: (res: Response) => Promise<void>;
  }) => {
    const { ids, lockRef, dismissRef, setActive, setProgress, actionLabel, finalizeLabel, url, onFetch } = opts;

    if (lockRef.current) {
      throw new Error(`${actionLabel} already in progress. Please wait.`);
    }

    const itemCount = ids.length;
    const expectedMs = Math.min(30000, Math.max(3000, itemCount * 20));
    const startedAt = Date.now();

    lockRef.current = true;
    if (dismissRef.current) {
      clearTimeout(dismissRef.current);
      dismissRef.current = null;
    }
    setActive(true);
    setProgress({
      itemCount,
      percent: 5,
      label: itemCount === 1 ? `${actionLabel} 1 item...` : `${actionLabel} ${itemCount} items...`,
    });

    const timer = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const percent = Math.min(95, Math.max(5, Math.round((elapsed / expectedMs) * 90) + 5));
      setProgress(prev => (prev ? { ...prev, percent } : prev));
    }, 250);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'include',
        body: JSON.stringify({ ids }),
      });

      if (onFetch) {
        await onFetch(res);
      } else if (!res.ok) {
        throw new Error(await extractResponseError(res));
      }

      clearInterval(timer);
      setProgress(prev => (prev ? { ...prev, percent: 100, label: `${finalizeLabel}...` } : prev));
      await refreshFiles();
      await new Promise(r => setTimeout(r, 450));
    } finally {
      clearInterval(timer);
      lockRef.current = false;
      setActive(false);
      dismissRef.current = setTimeout(() => {
        setProgress(null);
        dismissRef.current = null;
      }, 1500);
    }
  };

  const createFolder = async (name: string) => {
    const res = await fetch('/api/files/folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'include',
      body: JSON.stringify({ name, parentId: folderStack[folderStack.length - 1] }),
    });
    if (!res.ok) throw new Error(await extractResponseError(res));
    await refreshFiles();
  };

  const moveFiles = async (ids: string[], parentId: string | null) => {
    return operationQueue.add(async () => {
      const res = await fetch('/api/files/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'include',
        body: JSON.stringify({ ids, parentId }),
      });
      if (!res.ok) throw new Error(await extractResponseError(res));
      await refreshFiles();
    });
  };

  const copyFilesApi = async (ids: string[], parentId: string | null) => {
    return operationQueue.add(async () => {
      const res = await fetch('/api/files/copy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'include',
        body: JSON.stringify({ ids, parentId }),
      });
      if (!res.ok) throw new Error(await extractResponseError(res));
      await refreshFiles();
    });
  };

  const renameFileApi = async (id: string, name: string) => {
    const res = await fetch('/api/files/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'include',
      body: JSON.stringify({ id, name }),
    });

    if (!res.ok) {
      const errorMessage = await extractResponseError(res);
      showToast(errorMessage || 'Failed to rename item', 'error');
      throw new Error(errorMessage || 'Failed to rename item');
    }

    try {
      const updated: FileItemResponse = await res.json();
      showToast(`Renamed to "${updated.name || name}"`, 'success');
    } catch {
      showToast('Item renamed', 'success');
    }

    await refreshFiles();
  };

  const shareFilesApi = async (
    ids: string[],
    shared: boolean,
    expiry?: ShareExpiry
  ): Promise<Record<string, string>> => {
    const res = await fetch('/api/files/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'include',
      body: JSON.stringify({ ids, shared, ...(shared && expiry ? { expiry } : {}) }),
    });
    if (!res.ok) {
      const errorMessage = await extractResponseError(res);
      throw new Error(errorMessage || 'Failed to share files');
    }
    const data = await res.json();
    await refreshOrResearch();
    return data?.links || {};
  };

  const getShareLinks = async (ids: string[]): Promise<Record<string, string>> => {
    const res = await fetch('/api/files/share/links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'include',
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) throw new Error('Failed to get share links');
    const data = await res.json();
    return data?.links || {};
  };

  const starFilesApi = async (ids: string[], starred: boolean) => {
    const res = await fetch('/api/files/star', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'include',
      body: JSON.stringify({ ids, starred }),
    });
    if (!res.ok) {
      const errorMessage = await extractResponseError(res);
      throw new Error(errorMessage || 'Failed to update star status');
    }
    await refreshOrResearch();
  };

  const deleteFilesApi = async (ids: string[]) => {
    if (!ids.length) return;
    await runProgressOperation({
      ids,
      lockRef: deleteInProgressRef,
      dismissRef: deleteProgressDismissTimeoutRef,
      setActive: setIsDeleting,
      setProgress: setDeleteProgress,
      actionLabel: 'Deleting',
      finalizeLabel: 'Finalizing delete',
      url: '/api/files/delete',
    });
  };

  const restoreFilesApi = async (ids: string[]) => {
    if (!ids.length) return { success: true } as const;
    type RestoreResponse = { success: boolean; message?: string };
    let result: RestoreResponse | null = null;
    await runProgressOperation({
      ids,
      lockRef: restoreInProgressRef,
      dismissRef: restoreProgressDismissTimeoutRef,
      setActive: setIsRestoring,
      setProgress: setRestoreProgress,
      actionLabel: 'Restoring',
      finalizeLabel: 'Finalizing restore',
      url: '/api/files/trash/restore',
      onFetch: async res => {
        const data: unknown = await res.json();
        if (!res.ok) {
          const message =
            typeof (data as { message?: unknown }).message === 'string'
              ? ((data as { message?: unknown }).message as string)
              : undefined;
          throw new Error(message ?? 'Failed to restore files');
        }

        // Best-effort typing: backend should return `{ success: boolean, message?: string }`
        if (data && typeof data === 'object' && typeof (data as { success?: unknown }).success === 'boolean') {
          const success = (data as { success: boolean }).success;
          const message =
            typeof (data as { message?: unknown }).message === 'string'
              ? ((data as { message?: unknown }).message as string)
              : undefined;
          result = { success, ...(message ? { message } : {}) };
          return;
        }

        result = { success: false, message: 'Unexpected restore response from server.' };
      },
    });
    return result ?? { success: false, message: 'Restore did not return a response.' };
  };

  const deleteForeverApi = async (ids: string[]) => {
    if (!ids.length) return;
    await runProgressOperation({
      ids,
      lockRef: deleteInProgressRef,
      dismissRef: deleteProgressDismissTimeoutRef,
      setActive: setIsDeleting,
      setProgress: setDeleteProgress,
      actionLabel: 'Permanently deleting',
      finalizeLabel: 'Finalizing delete',
      url: '/api/files/trash/delete',
    });
  };

  const emptyTrashApi = async () => {
    const res = await fetch('/api/files/trash/empty', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'include',
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error((data && typeof data.message === 'string' && data.message) || 'Failed to empty trash');
    }
    const data = await res.json();
    await refreshFiles();
    return data;
  };

  const linkToParentShareApi = async (ids: string[]): Promise<Record<string, string>> => {
    const res = await fetch('/api/files/link-parent-share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      credentials: 'include',
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) throw new Error('Failed to link to parent share');
    const data = await res.json();
    await refreshFiles();
    return data?.links || {};
  };

  return {
    isDeleting,
    isRestoring,
    deleteProgress,
    restoreProgress,
    createFolder,
    moveFiles,
    copyFiles: copyFilesApi,
    renameFile: renameFileApi,
    shareFiles: shareFilesApi,
    getShareLinks,
    linkToParentShare: linkToParentShareApi,
    starFiles: starFilesApi,
    deleteFiles: deleteFilesApi,
    restoreFiles: restoreFilesApi,
    deleteForever: deleteForeverApi,
    emptyTrash: emptyTrashApi,
  };
}
