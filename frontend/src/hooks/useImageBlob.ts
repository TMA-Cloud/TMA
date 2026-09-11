import { useEffect, useState } from 'react';

/**
 * Returns the authenticated same-origin image stream URL. The browser streams
 * and caches the response directly instead of retaining a second full Blob in
 * JavaScript memory.
 */
export function useImageBlob(fileId: string | null | undefined): { imageSrc: string | null; loading: boolean } {
  const [loadedFileId, setLoadedFileId] = useState<string | null>(null);
  const [failedFileId, setFailedFileId] = useState<string | null>(null);
  const url = fileId ? `/api/files/${encodeURIComponent(fileId)}/download?inline=1` : null;

  useEffect(() => {
    if (!fileId || !url) return;

    let cancelled = false;
    const image = new Image();
    image.onload = () => {
      if (!cancelled) {
        setFailedFileId(null);
        setLoadedFileId(fileId);
      }
    };
    image.onerror = () => {
      if (!cancelled) setFailedFileId(fileId);
    };
    image.src = url;

    return () => {
      cancelled = true;
      image.onload = null;
      image.onerror = null;
      image.src = '';
    };
  }, [fileId, url]);

  return {
    imageSrc: failedFileId === fileId ? null : url,
    loading: Boolean(fileId && loadedFileId !== fileId && failedFileId !== fileId),
  };
}
