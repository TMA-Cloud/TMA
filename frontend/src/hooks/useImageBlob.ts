import { useEffect, useState } from 'react';
import { authFetch } from '../utils/authFetch';

/**
 * Fetches a file id as an image blob and returns an object URL.
 * Cancels in-flight requests on change/unmount and revokes previous URLs.
 */
export function useImageBlob(fileId: string | null | undefined): { imageSrc: string | null; loading: boolean } {
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let revoke: (() => void) | undefined;
    const abortController = new AbortController();

    Promise.resolve().then(async () => {
      if (!fileId) {
        setImageSrc(null);
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const res = await authFetch(`/api/files/${fileId}/download`, {
          signal: abortController.signal,
        });
        if (!res.ok) throw new Error(`Download failed: ${res.status}`);
        const contentType = res.headers.get('Content-Type') || '';
        if (!contentType.startsWith('image/')) throw new Error(`Unexpected Content-Type: ${contentType}`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        setImageSrc(url);
        revoke = () => URL.revokeObjectURL(url);
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') return;
        setImageSrc(null);
      } finally {
        if (!abortController.signal.aborted) setLoading(false);
      }
    });

    return () => {
      abortController.abort();
      if (revoke) {
        revoke();
        setImageSrc(null);
      }
    };
  }, [fileId]);

  return { imageSrc, loading };
}
