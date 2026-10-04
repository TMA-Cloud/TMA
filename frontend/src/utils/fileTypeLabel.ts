/**
 * Describes a file's type for Get Info, the way Explorer's "Type" column does:
 * the extension plus its family ("MKV video"), or "XYZ file" when the family
 * is unknown. The family comes from `getFileKind`, which falls back to the
 * extension's registered MIME type in mime-db (~1,300 extensions). The stored
 * MIME type only speaks when the name has no extension.
 */

import mime from 'mime';
import { getFileKind, type FileKind } from './fileKind';

const KIND_NOUN: Record<FileKind, string> = {
  document: 'document',
  pdf: 'document',
  spreadsheet: 'spreadsheet',
  presentation: 'presentation',
  image: 'image',
  design: 'design file',
  video: 'video',
  audio: 'audio',
  archive: 'archive',
  code: 'source file',
  database: 'database',
  text: 'text document',
  executable: 'application',
  font: 'font',
  generic: 'file',
};

export function getFileTypeLabel(name: string, mimeType?: string): string {
  const dot = name.lastIndexOf('.');
  // A leading dot is a hidden file's name, not an extension.
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (ext) {
    // mime-db, not the stored MIME type, which uploads often get wrong.
    const kind = getFileKind(name, mime.getType(ext) ?? undefined);
    return `${ext.toUpperCase()} ${KIND_NOUN[kind]}`;
  }
  const kind = getFileKind(name, mimeType);
  if (kind === 'pdf') return 'PDF document';
  const noun = KIND_NOUN[kind];
  return noun.charAt(0).toUpperCase() + noun.slice(1);
}
