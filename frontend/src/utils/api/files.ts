/** File-listing, upload-precheck, and single-file download endpoints. */
import { authFetch } from '../authFetch';
import { downloadBlob } from '../download';
import type { FileItemResponse } from '../../contexts/AppContext';
import { apiGet, apiPost } from './client';

/**
 * Files the account opened most recently. The server decides what "recently"
 * means and how many rows to hand back.
 */
export async function getRecentFiles(limit: number, signal?: AbortSignal): Promise<FileItemResponse[]> {
  return await apiGet<FileItemResponse[]>(`/api/files/recent?limit=${limit}`, { signal });
}

export async function checkUploadStorage(fileSize: number): Promise<{ allowed: true }> {
  return apiPost<{ allowed: true }>('/api/files/upload/check', { fileSize });
}

export async function downloadFile(id: string, fallbackFilename?: string): Promise<void> {
  const url = `/api/files/${id}/download`;
  const response = await authFetch(url, { method: 'GET' });

  if (!response.ok) {
    let errorMessage = response.statusText;
    try {
      const data = await response.json();
      errorMessage = data.message || data.error || response.statusText;
    } catch {
      // ignore
    }
    const error = new Error(errorMessage || `Download failed: ${response.statusText}`);
    (error as { status?: number }).status = response.status;
    throw error;
  }

  const contentDisposition = response.headers.get('Content-Disposition');
  let filename: string | null = null;

  if (contentDisposition) {
    const rfc5987Match = contentDisposition.match(/filename\*=UTF-8''([^;,\s]+)/i);
    if (rfc5987Match && rfc5987Match[1]) {
      try {
        filename = decodeURIComponent(rfc5987Match[1]);
      } catch {
        filename = rfc5987Match[1];
      }
    } else {
      const quotedMatch = contentDisposition.match(/filename="([^"]+)"/);
      if (quotedMatch && quotedMatch[1]) {
        filename = quotedMatch[1];
      } else {
        const unquotedMatch = contentDisposition.match(/filename=([^;,\s]+)/);
        if (unquotedMatch && unquotedMatch[1]) {
          filename = unquotedMatch[1].trim();
          try {
            filename = decodeURIComponent(filename);
          } catch {
            // use as is
          }
        }
      }
    }
  }

  if (!filename || filename.trim() === '') {
    filename = fallbackFilename || 'download';
  }

  const blob = await response.blob();
  downloadBlob(blob, filename);
}
