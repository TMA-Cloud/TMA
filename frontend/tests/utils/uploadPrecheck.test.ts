/**
 * The point of the pre-check is that a file whose content contradicts its name
 * is refused before any of it is sent — a 6GB upload should not have to finish
 * to learn what its first 8KiB already said.
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

/** A file big enough that sending it, rather than a sample of it, would hurt. */
function hugeFile(name: string, megabytes = 64) {
  const file = new File([new Uint8Array(1024)], name);
  Object.defineProperty(file, 'size', { value: megabytes * 1024 * 1024 });
  return file;
}

function requestBodies() {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
}

describe('precheckUploads', () => {
  it('sends a sample of each file rather than the file', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ allowed: true }));

    await precheckUploads([hugeFile('movie.mkv')], 64 * 1024 * 1024);

    const [body] = requestBodies();
    expect(body.samples).toHaveLength(1);
    expect(body.samples[0].name).toBe('movie.mkv');
    // 8KiB of content at most, base64-inflated by a third.
    expect(body.samples[0].head.length).toBeLessThanOrEqual(12 * 1024);
    expect(body.fileSize).toBe(64 * 1024 * 1024);
  });

  it('reports back the files the server refused', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          message: 'File content does not match extension .mkv',
          refused: [{ fileName: 'fake.mkv', reason: 'File content does not match extension .mkv' }],
        },
        415
      )
    );

    const refused = await precheckUploads([hugeFile('fake.mkv')], 1024);

    expect(refused).toEqual([{ fileName: 'fake.mkv', reason: 'File content does not match extension .mkv' }]);
  });

  it('splits large sets into batches that fit the request body limit', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ allowed: true }));
    const files = Array.from({ length: 70 }, (_, i) => hugeFile(`clip-${i}.mkv`, 1));

    await precheckUploads(files, 70 * 1024 * 1024);

    const bodies = requestBodies();
    expect(bodies.map(b => b.samples.length)).toEqual([32, 32, 6]);
    // The storage limit is a property of the whole upload, so only the first
    // batch claims the total; the rest would double-count it.
    expect(bodies.map(b => b.fileSize)).toEqual([70 * 1024 * 1024, 0, 0]);
  });

  it('collects refusals across batches instead of stopping at the first', async () => {
    const files = Array.from({ length: 40 }, (_, i) => hugeFile(`clip-${i}.mkv`, 1));
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ message: 'nope', refused: [{ fileName: 'clip-1.mkv', reason: 'nope' }] }, 415)
      )
      .mockResolvedValueOnce(
        jsonResponse({ message: 'nope', refused: [{ fileName: 'clip-33.mkv', reason: 'nope' }] }, 415)
      );

    const refused = await precheckUploads(files, 1024);

    expect(refused.map(r => r.fileName)).toEqual(['clip-1.mkv', 'clip-33.mkv']);
  });

  it('lets a storage-limit refusal through, because no file can proceed without room', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'Storage limit exceeded' }, 413));

    await expect(precheckUploads([hugeFile('movie.mkv')], 1024)).rejects.toThrow(/Storage limit exceeded/);
  });
});
