/**
 * Consume an NDJSON progress stream (see backend `streamBulkProgress`).
 *
 * Each line is one JSON object: `{type:'progress',done,total}`,
 * `{type:'done',...payload}`, or `{type:'error',message}`. `onProgress` is called
 * with a 0–99 percentage for each progress line (100 is left for the caller to
 * set once the operation is fully finalized). Resolves with the `done` payload,
 * or throws with the server's message on an `error` line.
 */
export async function consumeNdjsonProgress(
  res: Response,
  onProgress: (percent: number) => void
): Promise<Record<string, unknown> | null> {
  if (!res.body || typeof res.body.getReader !== 'function') return null;

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let donePayload: Record<string, unknown> | null = null;

  const handleLine = (raw: string) => {
    const line = raw.trim();
    if (!line) return;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return; // ignore a partial/garbled line
    }
    if (obj.type === 'progress') {
      const total = typeof obj.total === 'number' ? obj.total : 0;
      const done = typeof obj.done === 'number' ? obj.done : 0;
      onProgress(total > 0 ? Math.min(99, Math.round((done / total) * 100)) : 99);
    } else if (obj.type === 'done') {
      donePayload = obj;
    } else if (obj.type === 'error') {
      throw new Error(typeof obj.message === 'string' ? obj.message : 'Operation failed');
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      handleLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer) handleLine(buffer);

  return donePayload;
}
