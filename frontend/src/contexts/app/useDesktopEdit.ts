import { useEffect, useRef, useState } from 'react';
import { type FileItem } from '../AppContext';
import { editFileWithDesktopElectron, isElectron } from '../../utils/electronDesktop';
import { formatBytes } from '../../utils/storageUtils';

type ToastType = 'success' | 'error' | 'info';
type DesktopOpenProgress = { fileId: string; fileName: string; percent: number };

interface DesktopEditDeps {
  showToast: (message: string, type?: ToastType) => void;
  files: FileItem[];
  debouncedRefreshFiles: (...args: unknown[]) => void;
}

/** "Open on desktop" (Electron): stream to a native editor, show progress, refresh on save-back. */
export function useDesktopEdit({ showToast, files, debouncedRefreshFiles }: DesktopEditDeps) {
  const [desktopOpenProgress, setDesktopOpenProgress] = useState<DesktopOpenProgress[]>([]);
  const desktopEditInProgressRef = useRef<Set<string>>(new Set());

  // Electron derived upload status

  useEffect(() => {
    if (!isElectron()) return;
    const filesApi = window.electronAPI?.files;
    if (!filesApi?.onDerivedUploadStatus) return;

    const unsubscribe = filesApi.onDerivedUploadStatus(
      (payload: {
        state: 'started' | 'completed' | 'error';
        fileName: string;
        size?: number;
        originalId?: string;
        error?: string;
      }) => {
        const truncate = (name: string, max = 65): string => {
          if (!name || name.length <= max) return name;
          const dots = '......';
          const extIdx = name.lastIndexOf('.');
          const ext = extIdx > 0 && extIdx < name.length - 1 ? name.slice(extIdx) : '';
          const baseMax = max - dots.length - ext.length;
          return baseMax <= 0 ? name.slice(0, max - dots.length) + dots : `${name.slice(0, baseMax)}${dots}${ext}`;
        };
        const display = truncate(payload.fileName);

        if (payload.state === 'started') {
          const size = payload.size != null ? ` (${formatBytes(payload.size)})` : '';
          showToast(`Saving "${display}"${size}`, 'info');
        } else if (payload.state === 'completed') {
          showToast(`Exported "${display}"`, 'success');
          debouncedRefreshFiles(true);
        } else if (payload.state === 'error') {
          showToast(payload.error || `Failed to save "${display}"`, 'error');
        }
      }
    );

    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [debouncedRefreshFiles, showToast]);

  const editFileWithDesktop = async (id: string) => {
    if (desktopEditInProgressRef.current.has(id)) {
      showToast('Already opening this file…', 'info');
      return;
    }

    const file = files.find(f => f.id === id);
    if (!file || String(file.type || '').toLowerCase() === 'folder') {
      showToast('Select one file to open on desktop', 'error');
      return;
    }
    if (!file.mimeType) {
      showToast("Can't open on desktop — unknown file type", 'error');
      return;
    }

    desktopEditInProgressRef.current.add(id);
    const isLarge = Number(file.size ?? 0) >= 50 * 1024 * 1024;
    let succeeded = false;
    const BASE_DURATION = isLarge ? 20000 : 8000;
    const MAX_PERCENT = 90;
    const TICK = 300;
    const startTime = Date.now();

    setDesktopOpenProgress(prev => {
      const base = { fileId: file.id, fileName: file.name, percent: 5 };
      const idx = prev.findIndex(p => p.fileId === file.id);
      if (idx === -1) return [...prev, base];
      const next = [...prev];
      next[idx] = base;
      return next;
    });

    const tick = () => {
      if (!desktopEditInProgressRef.current.has(id)) return;
      const percent = Math.max(
        5,
        Math.min(MAX_PERCENT, Math.round(((Date.now() - startTime) / BASE_DURATION) * MAX_PERCENT))
      );
      setDesktopOpenProgress(prev => {
        const idx = prev.findIndex(p => p.fileId === file.id);
        if (idx === -1) return prev;
        const next = [...prev];
        next[idx] = { ...next[idx]!, percent };
        return next;
      });
      if (percent < MAX_PERCENT) setTimeout(tick, TICK);
    };
    setTimeout(tick, TICK);

    try {
      const result = await editFileWithDesktopElectron({ id: file.id, name: file.name });
      if (!result.ok) {
        showToast(result.error ?? 'Failed to open file on desktop', 'error');
        return;
      }

      succeeded = true;
      setDesktopOpenProgress(prev => {
        const idx = prev.findIndex(p => p.fileId === file.id);
        if (idx === -1) return prev;
        const next = [...prev];
        next[idx] = { ...next[idx]!, percent: 100 };
        return next;
      });
      setTimeout(() => setDesktopOpenProgress(prev => prev.filter(p => p.fileId !== file.id)), 800);
      showToast('Opened on desktop — changes sync back automatically', 'success');
    } finally {
      desktopEditInProgressRef.current.delete(id);
      if (!succeeded) {
        setDesktopOpenProgress(prev => prev.filter(p => p.fileId !== file.id));
      }
    }
  };

  return { desktopOpenProgress, setDesktopOpenProgress, editFileWithDesktop };
}
