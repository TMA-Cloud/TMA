import { describe, expect, it } from 'vitest';

import {
  collectUploadParts,
  extractFolderSegmentsFromRelativePath,
  metadataForPart,
} from '../../../utils/uploadParts.js';

/**
 * A folder upload sends its shape in fields that run parallel to the file
 * parts. When the stream middleware refuses a file, that file's parts are gone
 * but its metadata entries are not, so anything that reads the metadata by
 * position rebuilds the tree with files in each other's folders.
 */

const body = {
  relativePaths: [
    'Galaxy/Systems/core/Architecture_Diagram.eps',
    'Galaxy/Systems/Engine_Noise.mpeg',
    "Galaxy/Don't panic.png",
    'Galaxy/MANUAL_V2.pdf',
    'Galaxy/Logo_Final.jpeg',
  ],
  clientIds: ['c0', 'c1', 'c2', 'c3', 'c4'],
  lastModifiedTimes: ['1700000000000', '1700000001000', '1700000002000', '1700000003000', '1700000004000'],
};

describe('metadataForPart', () => {
  it('gives a file the metadata of its own part', () => {
    const parts = collectUploadParts(body);
    expect(metadataForPart(parts, 2)).toMatchObject({
      relativePath: "Galaxy/Don't panic.png",
      clientId: 'c2',
    });
  });

  it('keeps every survivor on its own path when earlier parts were rejected', () => {
    const parts = collectUploadParts(body);
    // Parts 0 and 1 failed the magic-byte check, so the uploads that reached
    // storage are 2, 3 and 4 — the first three entries of a compacted list.
    const survivors = [2, 3, 4].map(index => metadataForPart(parts, index).relativePath);

    expect(survivors).toEqual(["Galaxy/Don't panic.png", 'Galaxy/MANUAL_V2.pdf', 'Galaxy/Logo_Final.jpeg']);
  });

  it('carries the timestamp of its own part, not of the file before it', () => {
    const parts = collectUploadParts(body);
    expect(metadataForPart(parts, 4).modified).toEqual(new Date(1700000004000));
  });

  it('returns empty metadata for a part with no ordinal or none recorded', () => {
    const parts = collectUploadParts(body);
    for (const index of [undefined, null, -1, 1.5, 99]) {
      expect(metadataForPart(parts, index)).toEqual({ relativePath: null, clientId: null, modified: null });
    }
  });

  it('handles a single-file upload, where the fields arrive unwrapped', () => {
    const parts = collectUploadParts({ relativePaths: 'Docs/report.pdf', clientIds: 'only' });
    expect(metadataForPart(parts, 0)).toMatchObject({ relativePath: 'Docs/report.pdf', clientId: 'only' });
  });

  it('survives a request that sent no metadata at all', () => {
    const parts = collectUploadParts({});
    expect(metadataForPart(parts, 0)).toEqual({ relativePath: null, clientId: null, modified: null });
  });
});

describe('extractFolderSegmentsFromRelativePath', () => {
  it('keeps the folders and drops the file', () => {
    expect(
      extractFolderSegmentsFromRelativePath('Galaxy/Systems/core/Architecture_Diagram.eps', 'Architecture_Diagram.eps')
    ).toEqual(['Galaxy', 'Systems', 'core']);
  });

  it('reads backslashes as separators, as Windows clients send them', () => {
    expect(extractFolderSegmentsFromRelativePath('Galaxy\\Systems\\thruster.mp4', 'thruster.mp4')).toEqual([
      'Galaxy',
      'Systems',
    ]);
  });

  it('drops a file name that has no extension when it matches the file', () => {
    expect(extractFolderSegmentsFromRelativePath('Galaxy/Systems/README', 'README')).toEqual(['Galaxy', 'Systems']);
  });

  it('returns nothing for a loose file with no path', () => {
    expect(extractFolderSegmentsFromRelativePath('', 'thruster.mp4')).toEqual([]);
    expect(extractFolderSegmentsFromRelativePath(null, 'thruster.mp4')).toEqual([]);
  });
});
