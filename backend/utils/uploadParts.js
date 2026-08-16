/**
 * What the uploader sent alongside each file of a multipart upload.
 *
 * A bulk upload carries one `files` part per file plus repeated `relativePaths`,
 * `clientIds` and `lastModifiedTimes` fields — one entry each, in part order,
 * which RFC 7578 requires intermediaries to preserve. That makes them parallel
 * arrays, and parallel arrays only hold while every removal is applied to all of
 * them at once. The S3 stream middleware drops the parts it refuses, so the join
 * has to be on a part's own ordinal rather than on its position in whatever
 * survived.
 */

import { validateClientMtime } from './validation.js';

/**
 * A repeated form field as an array, whatever arity it arrived with.
 * @param {string|string[]|null|undefined} value
 * @returns {string[]}
 */
function normalizeMultipartArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map(v => (v == null ? '' : String(v)));
  return [String(value)];
}

/**
 * The mtimes the uploader sent, one per file part. Entries that fail validation
 * become null, which leaves that row's `modified` at the upload time rather than
 * failing the whole batch over one machine's bad clock.
 * @param {string|string[]|null|undefined} value
 * @returns {(Date|null)[]}
 */
function normalizeClientMtimes(value) {
  return normalizeMultipartArray(value).map(v => validateClientMtime(v));
}

/**
 * Collects the repeated metadata fields of a bulk upload request.
 * @param {Object} body - Parsed multipart fields
 * @returns {{relativePaths: string[], clientIds: string[], clientMtimes: (Date|null)[]}}
 */
function collectUploadParts(body) {
  return {
    relativePaths: normalizeMultipartArray(body?.relativePaths),
    clientIds: normalizeMultipartArray(body?.clientIds),
    clientMtimes: normalizeClientMtimes(body?.lastModifiedTimes),
  };
}

/**
 * Pairs one file with the metadata its own part carried.
 *
 * Keyed on the part ordinal, never on a position in a filtered list: reading
 * these arrays by position after a rejected file has been dropped hands every
 * later file the folder and timestamp belonging to a different one, which
 * rebuilds the uploaded tree in the wrong shape.
 *
 * @param {{relativePaths: string[], clientIds: string[], clientMtimes: (Date|null)[]}} parts
 * @param {number} partIndex - Ordinal of the file part within the request
 * @returns {{relativePath: string|null, clientId: string|null, modified: Date|null}}
 */
function metadataForPart(parts, partIndex) {
  if (!Number.isInteger(partIndex) || partIndex < 0) {
    return { relativePath: null, clientId: null, modified: null };
  }
  return {
    relativePath: parts.relativePaths[partIndex] || null,
    clientId: parts.clientIds[partIndex] || null,
    modified: parts.clientMtimes[partIndex] || null,
  };
}

/**
 * The folder part of a browser-supplied relative path ("Trip/Videos/clip.mp4"
 * to ["Trip", "Videos"]), which is what the uploaded tree is rebuilt from.
 * @param {string} relativePath
 * @param {string} fallbackFileName - The file's own name, to spot the last segment
 * @returns {string[]}
 */
function extractFolderSegmentsFromRelativePath(relativePath, fallbackFileName) {
  if (!relativePath || typeof relativePath !== 'string') return [];
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!normalized) return [];
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return [];

  // Most browsers provide "RootFolder/sub/filename.ext". We only want the folder parts.
  const last = parts[parts.length - 1];
  const isLastFile =
    (fallbackFileName && last === fallbackFileName) ||
    // fallback heuristic: if it has a dot, treat as a filename
    (typeof last === 'string' && last.includes('.'));

  return isLastFile ? parts.slice(0, -1) : parts;
}

export {
  collectUploadParts,
  extractFolderSegmentsFromRelativePath,
  metadataForPart,
  normalizeClientMtimes,
  normalizeMultipartArray,
};
