/**
 * Sorts a file into one of a small set of kinds, each with its own artwork.
 *
 * The extension decides first: it is what the user named and what the OS will
 * open the file with, while uploads often arrive as `application/octet-stream`.
 * The MIME type only breaks the tie when the extension is missing or unknown.
 */

export type FileKind =
  | 'document'
  | 'pdf'
  | 'spreadsheet'
  | 'presentation'
  | 'image'
  | 'design'
  | 'video'
  | 'audio'
  | 'archive'
  | 'code'
  | 'database'
  | 'text'
  | 'executable'
  | 'font'
  | 'generic';

// Space-separated so each kind stays one line under Prettier.
const EXTENSIONS: Record<Exclude<FileKind, 'generic'>, string> = {
  document: 'doc docx docm dot dotx odt rtf pages wpd epub mobi',
  pdf: 'pdf',
  spreadsheet: 'xls xlsx xlsm xlsb xlt xltx ods csv tsv numbers',
  presentation: 'ppt pptx pptm pps ppsx pot potx odp key',
  image: 'png jpg jpeg gif webp avif bmp svg ico tif tiff heic heif raw cr2 nef arw dng',
  // Editable source files: opened in a design tool, not an image viewer.
  design: 'ai eps psd psb indd idml xd sketch fig afdesign afphoto cdr xcf',
  video: 'mp4 m4v mov avi mkv webm wmv flv mpg mpeg 3gp mts',
  audio: 'mp3 wav flac aac m4a ogg oga opus wma aiff aif mid midi',
  archive: 'zip zipx rar 7z tar gz tgz bz2 xz lz lzma zst cab z',
  code: 'js jsx mjs cjs ts tsx json html htm css scss less py rb php java kt c h cpp hpp cs go rs swift sh ps1 bat cmd xml yaml yml toml ini vue svelte lua r pl dart',
  database: 'db sqlite sqlite3 sql mdb accdb dbf parquet',
  text: 'txt md markdown log rst nfo',
  executable: 'exe msi msix appx apk aab app dmg pkg deb rpm iso img jar',
  font: 'ttf otf woff woff2 eot',
};

// `ts` is left to code: in a drive it is far more often TypeScript than an
// MPEG transport stream.
const BY_EXTENSION = new Map<string, FileKind>(
  (Object.entries(EXTENSIONS) as [FileKind, string][]).flatMap(([kind, exts]) =>
    exts.split(' ').map(ext => [ext, kind] as const)
  )
);

/** Substring rules for MIME types, checked in order; the first hit wins. */
const BY_MIME: [test: (mime: string) => boolean, kind: FileKind][] = [
  [m => m === 'application/pdf', 'pdf'],
  [m => /photoshop|postscript|illustrator/.test(m), 'design'],
  [m => m.startsWith('image/'), 'image'],
  [m => m.startsWith('video/'), 'video'],
  [m => m.startsWith('audio/'), 'audio'],
  [m => m.startsWith('font/'), 'font'],
  [m => m.includes('spreadsheet') || m.includes('excel') || m === 'text/csv', 'spreadsheet'],
  [m => m.includes('presentation') || m.includes('powerpoint'), 'presentation'],
  [m => m.includes('wordprocessing') || m.includes('msword') || m.includes('opendocument.text'), 'document'],
  [m => /zip|compressed|x-tar|x-7z|x-rar|gzip/.test(m), 'archive'],
  [m => /javascript|typescript|json|xml|html|css|x-sh|x-python/.test(m), 'code'],
  [m => m.includes('sql'), 'database'],
  [m => m.includes('executable') || m.includes('msdownload') || m.includes('x-msi'), 'executable'],
  [m => m.startsWith('text/'), 'text'],
];

export function getFileKind(name: string, mimeType?: string): FileKind {
  const dot = name.lastIndexOf('.');
  // A leading dot is a hidden file's name, not an extension.
  if (dot > 0) {
    const kind = BY_EXTENSION.get(name.slice(dot + 1).toLowerCase());
    if (kind) return kind;
  }
  if (mimeType) {
    const mime = mimeType.toLowerCase();
    for (const [test, kind] of BY_MIME) if (test(mime)) return kind;
  }
  return 'generic';
}
