import { describe, expect, it, vi } from 'vitest';

const { putStream, deleteObject } = vi.hoisted(() => ({
  putStream: vi.fn(async () => {}),
  deleteObject: vi.fn(async () => {}),
}));
vi.mock('../../../utils/s3Storage.js', () => ({ putStream, deleteObject }));
const storage = (await import('../../../utils/storageDriver.js')).default;

describe('bucket storage', () => {
  it('passes the stream and known content length to S3', async () => {
    const body = {};
    await storage.putStream('file.bin', body, 42);
    expect(putStream).toHaveBeenCalledWith('file.bin', body, 42);
  });
  it('propagates bucket failures', async () => {
    deleteObject.mockRejectedValueOnce(new Error('Bucket unavailable'));
    await expect(storage.deleteObject('file.bin')).rejects.toThrow('Bucket unavailable');
  });
});
