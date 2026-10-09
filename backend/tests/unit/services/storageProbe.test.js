import { Readable } from 'stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { send, destroy } = vi.hoisted(() => ({ send: vi.fn(), destroy: vi.fn() }));

vi.mock('../../../config/logger.js', () => ({ logger: { warn: vi.fn() } }));
vi.mock('@aws-sdk/client-s3', () => {
  const command = kind =>
    class {
      constructor(input) {
        this.kind = kind;
        this.input = input;
      }
    };
  return {
    DeleteObjectCommand: command('delete'),
    GetObjectCommand: command('get'),
    HeadBucketCommand: command('head-bucket'),
    HeadObjectCommand: command('head'),
    ListObjectsV2Command: command('list'),
    PutObjectCommand: command('put'),
    S3Client: class {
      send(cmd) {
        return send(cmd);
      }
      destroy() {
        destroy();
      }
    },
  };
});

const { probeStorage } = await import('../../../services/storageProbe.js');

const CONFIG = {
  endpoint: 'https://s3.example.com',
  region: 'us-east-1',
  bucket: 'tma-files',
  forcePathStyle: true,
  accessKeyId: 'KEY',
  secretAccessKey: 'SECRET',
};

/** An in-memory bucket that answers the probe's commands. */
function healthyStore(existing = []) {
  const objects = new Map(existing.map(key => [key, Buffer.from('x')]));
  send.mockImplementation(async cmd => {
    const { Key } = cmd.input;
    switch (cmd.kind) {
      case 'put':
        objects.set(Key, cmd.input.Body);
        return {};
      case 'get':
        return { Body: Readable.from([objects.get(Key)]) };
      case 'head':
        if (!objects.has(Key)) throw Object.assign(new Error('NotFound'), { $metadata: { httpStatusCode: 404 } });
        return {};
      case 'delete':
        objects.delete(Key);
        return {};
      default:
        return {};
    }
  });
  return objects;
}

beforeEach(() => {
  send.mockReset();
  destroy.mockReset();
});

describe('probeStorage', () => {
  it('passes every check and leaves no probe object behind', async () => {
    const objects = healthyStore();

    await expect(probeStorage(CONFIG)).resolves.toEqual({ checks: ['connect', 'list', 'write', 'read', 'delete'] });
    expect(objects.size).toBe(0);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('accepts a target that holds at least one existing file', async () => {
    healthyStore(['abc.bin']);

    const { checks } = await probeStorage(CONFIG, { sampleKeys: ['abc.bin', 'missing.bin'] });
    expect(checks).toContain('existing-files');
  });

  it('refuses a target that holds none of the existing files', async () => {
    healthyStore();

    await expect(probeStorage(CONFIG, { sampleKeys: ['abc.bin'] })).rejects.toMatchObject({
      name: 'StorageProbeError',
      step: 'existing-files',
      status: 422,
    });
  });

  it.each([
    [{ name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } }, 'was not found'],
    [{ name: 'InvalidAccessKeyId', $metadata: { httpStatusCode: 403 } }, 'was rejected'],
    [{ name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }, 'Access denied'],
    [{ name: 'Error', code: 'ECONNREFUSED' }, 'Could not connect'],
    [{ name: 'TimeoutError' }, 'did not respond'],
  ])('explains a %o failure without leaking provider details', async (failure, message) => {
    send.mockRejectedValue(Object.assign(new Error('raw provider detail'), failure));

    const err = await probeStorage(CONFIG).catch(e => e);
    expect(err).toMatchObject({ step: 'connect' });
    expect(err.message).toContain(message);
    expect(err.message).not.toContain('raw provider detail');
  });

  it('still deletes the probe object when the read-back fails', async () => {
    const objects = healthyStore();
    send.mockImplementation(async cmd => {
      if (cmd.kind === 'put') objects.set(cmd.input.Key, cmd.input.Body);
      if (cmd.kind === 'get') return { Body: Readable.from([Buffer.from('different')]) };
      if (cmd.kind === 'delete') objects.delete(cmd.input.Key);
      return {};
    });

    await expect(probeStorage(CONFIG)).rejects.toMatchObject({ step: 'read' });
    expect(objects.size).toBe(0);
  });

  it('stops reading a body far larger than the probe object', async () => {
    const objects = healthyStore();
    let served = 0;
    function* endless() {
      for (;;) {
        served += 1;
        yield Buffer.alloc(16 * 1024);
      }
    }
    send.mockImplementation(async cmd => {
      if (cmd.kind === 'put') objects.set(cmd.input.Key, cmd.input.Body);
      if (cmd.kind === 'get') return { Body: Readable.from(endless()) };
      if (cmd.kind === 'delete') objects.delete(cmd.input.Key);
      return {};
    });

    await expect(probeStorage(CONFIG)).rejects.toMatchObject({ step: 'read' });
    expect(served).toBeLessThan(10);
    expect(objects.size).toBe(0);
  });
});
