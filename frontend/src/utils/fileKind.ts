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
  document: 'doc docx docm dot dotx odt rtf pages wpd epub mobi azw azw3 kfx xps oxps',
  pdf: 'pdf',
  spreadsheet: 'xls xlsx xlsm xlsb xlt xltx ods csv tsv numbers',
  presentation: 'ppt pptx pptm pps ppsx pot potx odp key',
  image:
    'png jpg jpeg gif webp avif bmp svg ico tif tiff heic heif raw jxl cr2 cr3 nef arw dng raf orf rw2 pef srw dcm',
  // Editable source files: opened in a design tool, not an image viewer.
  design: 'ai eps psd psb indd idml xd sketch fig afdesign afphoto afpub cdr xcf kra procreate clip odg lottie riv',
  video: 'mp4 m4v mov avi mkv webm wmv flv mpg mpeg 3gp mts m2ts hevc flc',
  audio: 'mp3 wav flac aac m4a ogg oga opus wma aiff aif mid midi',
  archive: 'zip zipx rar 7z tar gz tgz bz2 xz lz lzma zst lz4 br cab z cbz cbr',
  code: 'js jsx mjs cjs ts tsx json html htm css scss less py rb php java kt c h cpp hpp cs go rs swift sh ps1 bat cmd xml yaml yml toml ini vue svelte astro lua r pl dart zig scala kts ex exs hs ml clj graphql gql proto tf hcl nix ipynb jsonc json5 qml',
  database: 'db sqlite sqlite3 sql mdb accdb dbf parquet arrow feather avro orc',
  text: 'txt md markdown log rst nfo srt',
  executable: 'exe msi msix appx apk aab app dmg pkg deb rpm iso img jar appimage snap flatpak ipa xpi crx',
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
  // Whole subtype only: a substring would put x-shockwave-flash under x-sh.
  [m => /\/(x-)?(javascript|typescript|json|xml|xhtml|html|css|sh|shellscript|python)$/.test(m), 'code'],
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
    // An RFC 6839 suffix names the container, not the content: atom+xml is a
    // feed, not code, and usdz+zip is a 3D model, not an archive.
    const essence = mimeType.toLowerCase().split(';')[0]!.trim();
    const mime = essence.replace(/\+[a-z0-9-]+$/, '');
    for (const [test, kind] of BY_MIME) if (test(mime)) return kind;
  }
  return 'generic';
}
