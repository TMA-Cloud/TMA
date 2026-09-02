import { useRef, useState } from 'react';
import { type FileItem } from '../AppContext';
import { downloadFile as downloadFileApi } from '../../utils/api';
import { extractResponseError } from '../../utils/errorUtils';
import { isElectron, saveFileViaElectron, saveFilesBulkViaElectron } from '../../utils/electronDesktop';
import { parseContentDispositionFilename } from './helpers';

type ToastType = 'success' | 'error' | 'info';

interface DownloadsDeps {
  showToast: (message: string, type?: ToastType) => void;
  files: FileItem[];
}

/** Download: Electron saves via the desktop bridge; web streams one file or zips many. */
export function useDownloads({ showToast, files }: DownloadsDeps) {
  const [isDownloading, setIsDownloading] = useState(false);
  const downloadInProgressRef = useRef(false);

  const downloadFiles = async (ids: string[]) => {
    // Guard with a ref, not state: two rapid clicks could both read a stale false.
    if (downloadInProgressRef.current || ids.length === 0) return;
    downloadInProgressRef.current = true;

    setIsDownloading(true);
    try {
      if (isElectron()) {
        if (ids.length > 1) {
          const result = await saveFilesBulkViaElectron(ids);
          if (result.ok) showToast('Files saved', 'success');
          else if (!result.canceled && result.error) showToast(result.error, 'error');
        } else {
          const firstId = ids[0];
          if (!firstId) return;
          const file = files.find(f => f.id === firstId);
          const fileName = file?.name || (file?.type === 'folder' ? 'folder' : 'file');
          const suggestedFileName = file?.type === 'folder' ? `${fileName}.zip` : fileName;
          const result = await saveFileViaElectron({ fileId: firstId, suggestedFileName });
          if (result.ok) showToast('File saved', 'success');
          else if (!result.canceled && result.error) showToast(result.error, 'error');
        }
        return;
      }

      // Web: bulk download creates a single ZIP
      if (ids.length > 1) {
        const res = await fetch('/api/files/download/bulk', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          credentials: 'include',
          body: JSON.stringify({ ids }),
        });

        if (!res.ok) {
          const errorMessage = await extractResponseError(res);
          showToast(errorMessage || 'Failed to download files', 'error');
          throw new Error(errorMessage || 'Failed to download files');
        }

        const filename = parseContentDispositionFilename(
          res.headers.get('Content-Disposition'),
          `download_${Date.now()}.zip`
        );
        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        // Defer revocation so the browser has time to start the download
        setTimeout(() => window.URL.revokeObjectURL(url), 1000);
      } else {
        const firstId = ids[0];
        if (!firstId) return;
        const file = files.find(f => f.id === firstId);
        if (file) {
          const fileName = file.name || (file.type === 'folder' ? 'folder' : 'file');
          await downloadFileApi(firstId, file.type === 'folder' ? `${fileName}.zip` : fileName);
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      showToast(errorMessage || 'Failed to download files', 'error');
    } finally {
      downloadInProgressRef.current = false;
      setIsDownloading(false);
    }
  };

  return { isDownloading, downloadFiles };
}
