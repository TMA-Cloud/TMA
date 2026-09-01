/**
 * The pre-check confirms an upload fits the storage quota before any bytes are
 * sent. It does not inspect content: this is a general-purpose store that keeps
 * any file, so a content/extension mismatch never blocks an upload.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { precheckUploads } from '../../src/utils/uploadUtils';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function requestBodies() {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
}

describe('precheckUploads', () => {
  it('sends the total size and nothing about the content', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ allowed: true }));

    await precheckUploads(64 * 1024 * 1024);

    const [body] = requestBodies();
    expect(body.fileSize).toBe(64 * 1024 * 1024);
    // No file content is sampled or sent — only the size is checked.
    expect(body.samples).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('resolves when the upload fits', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ allowed: true }));

    await expect(precheckUploads(1024)).resolves.toBeUndefined();
  });

  it('throws a storage-limit refusal through, because no file can proceed without room', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Storage limit exceeded' }, 413));

    await expect(precheckUploads(64 * 1024 * 1024)).rejects.toThrow(/Storage limit exceeded/);
  });
});
