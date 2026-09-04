/**
 * Streams the body with a reader and counts bytes against Content-Length, the
 * standard way to track download progress (https://javascript.info/fetch-progress).
 * When the length is absent — a streamed/chunked ZIP, or a gzip-encoded body —
 * `total` is passed as null so the caller can show an indeterminate bar while
 * still surfacing bytes received. Falls back to `response.blob()` when the
 * platform lacks a streaming body. Memory profile matches `.blob()`: the whole
 * payload is buffered before the browser save is triggered.
 */
export async function streamResponseToBlob(
  response: Response,
  onProgress?: (loaded: number, total: number | null) => void
): Promise<Blob> {
  const header = response.headers.get('Content-Length');
  const total = header ? Number(header) : NaN;
  const knownTotal = Number.isFinite(total) && total > 0 ? total : null;
  const contentType = response.headers.get('Content-Type') || 'application/octet-stream';

  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const blob = await response.blob();
    onProgress?.(blob.size, blob.size || null);
    return blob;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  onProgress?.(0, knownTotal);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.length;
      // A body larger than its declared length (rare) shouldn't report >100%.
      onProgress?.(loaded, knownTotal !== null ? Math.max(knownTotal, loaded) : null);
    }
  }
  return new Blob(chunks as BlobPart[], { type: contentType });
}

/**
 * Trigger a browser download for an in-memory blob.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => window.URL.revokeObjectURL(url), 1000);
}
