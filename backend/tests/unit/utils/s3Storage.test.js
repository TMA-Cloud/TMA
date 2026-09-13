import { beforeEach, describe, expect, it, vi } from 'vitest';

const { storageSend } = vi.hoisted(() => ({ storageSend: vi.fn() }));

vi.mock('../../../config/storage.js', () => ({
  s3: {
    endpoint: 'https://example.invalid',
    region: 'auto',
    bucket: 'bucket',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    forcePathStyle: false,
  },
}));
vi.mock('../../../config/logger.js', () => ({ logger: { warn: vi.fn() } }));
vi.mock('../../../utils/fileEncryption.js', () => ({ plaintextSizeToCiphertextSize: size => size + 1024 }));
vi.mock('@aws-sdk/lib-storage', () => ({ Upload: class {} }));
vi.mock('@aws-sdk/client-s3', () => {
  const command = kind =>
    class {
      constructor(input) {
        this.kind = kind;
        this.input = input;
      }
    };
  return {
    AbortMultipartUploadCommand: command('abort'),
    CompleteMultipartUploadCommand: command('complete'),
    CopyObjectCommand: command('copy'),
    CreateMultipartUploadCommand: command('create'),
    DeleteObjectCommand: command('delete'),
    DeleteObjectsCommand: command('delete-many'),
    GetObjectCommand: command('get'),
    HeadObjectCommand: command('head'),
    ListObjectsV2Command: command('list'),
    PutObjectCommand: command('put'),
    UploadPartCopyCommand: command('copy-part'),
    S3Client: class {
      send(commandInstance) {
        return storageSend(commandInstance);
      }
    },
  };
});

const { multipartCopyObject } = await import('../../../utils/s3Storage.js');

const SOURCE_SIZE = 600 * 1024 ** 2;

beforeEach(() => {
  storageSend.mockReset();
});

describe('multipartCopyObject', () => {
  it('sorts asynchronously completed parts before committing', async () => {
    storageSend.mockImplementation(async command => {
      if (command.kind === 'create') return { UploadId: 'upload-1' };
      if (command.kind === 'copy-part') {
        await new Promise(resolve => {
          setTimeout(resolve, (4 - command.input.PartNumber) * 2);
        });
        return { CopyPartResult: { ETag: `etag-${command.input.PartNumber}` } };
      }
      return {};
    });

    await multipartCopyObject('source', 'destination', SOURCE_SIZE);

    const completed = storageSend.mock.calls.map(([command]) => command).find(command => command.kind === 'complete');
    expect(completed.input.MultipartUpload.Parts).toEqual([
      { ETag: 'etag-1', PartNumber: 1 },
      { ETag: 'etag-2', PartNumber: 2 },
      { ETag: 'etag-3', PartNumber: 3 },
    ]);
  });

  it('waits for in-flight parts and aborts instead of committing after a failure', async () => {
    storageSend.mockImplementation(async command => {
      if (command.kind === 'create') return { UploadId: 'upload-2' };
      if (command.kind === 'copy-part') {
        await new Promise(resolve => {
          setTimeout(resolve, command.input.PartNumber === 1 ? 10 : 1);
        });
        if (command.input.PartNumber === 2) throw new Error('copy failed');
        return { CopyPartResult: { ETag: `etag-${command.input.PartNumber}` } };
      }
      return {};
    });

    await expect(multipartCopyObject('source', 'destination', SOURCE_SIZE)).rejects.toThrow('copy failed');

    const commands = storageSend.mock.calls.map(([command]) => command.kind);
    expect(commands).not.toContain('complete');
    expect(commands.at(-1)).toBe('abort');
  });
});
