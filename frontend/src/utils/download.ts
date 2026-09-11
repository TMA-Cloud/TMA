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

export interface DownloadFileSink {
  writeResponse: (response: Response, onProgress?: (loaded: number, total: number | null) => void) => Promise<void>;
}

/**
 * Ask for the destination before starting network I/O, preserving browser user
 * activation. Unsupported browsers return null and use the Blob fallback.
 */
export async function openDownloadFileSink(filename: string): Promise<DownloadFileSink | null> {
  const picker = (
    window as Window & {
      showSaveFilePicker?: (options?: { suggestedName?: string }) => Promise<{
        createWritable: () => Promise<WritableStream<Uint8Array>>;
      }>;
    }
  ).showSaveFilePicker;
  if (!picker) return null;

  const handle = await picker({ suggestedName: filename });
  const writable = await handle.createWritable();
  return {
    async writeResponse(response, onProgress) {
      if (!response.body) {
        const blob = await response.blob();
        const writer = writable.getWriter();
        await writer.write(new Uint8Array(await blob.arrayBuffer()));
        await writer.close();
        onProgress?.(blob.size, blob.size || null);
        return;
      }
      const header = response.headers.get('Content-Length');
      const parsed = header ? Number(header) : NaN;
      const total = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      let loaded = 0;
      const progress = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          loaded += chunk.byteLength;
          onProgress?.(loaded, total !== null ? Math.max(total, loaded) : null);
          controller.enqueue(chunk);
        },
      });
      onProgress?.(0, total);
      await response.body.pipeThrough(progress).pipeTo(writable);
    },
  };
}

export async function saveResponseDownload(
  response: Response,
  filename: string,
  onProgress?: (loaded: number, total: number | null) => void,
  sink?: DownloadFileSink | null
): Promise<void> {
  if (sink) {
    await sink.writeResponse(response, onProgress);
    return;
  }
  const blob = await streamResponseToBlob(response, onProgress);
  downloadBlob(blob, filename);
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
