/**
 * Sorts a file into one of a small set of kinds, for the public share page.
 * Mirrors frontend/src/utils/fileKind.ts so a file reads the same in both.
 *
 * The extension decides first: it is what the user named and what the OS will
 * open the file with, while stored types are often `application/octet-stream`
 * or a browser's guess (`.ts` uploads as `video/mp2t`). An extension the table
 * lacks is looked up in mime-db; only a name with no extension falls back to
 * the stored MIME type.
 */
import mimeTypes from 'mime-types';

// Space-separated so each kind stays one line under Prettier.
const EXTENSIONS = {
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

const BY_EXTENSION = new Map(
  Object.entries(EXTENSIONS).flatMap(([kind, exts]) => exts.split(' ').map(ext => [ext, kind]))
);

/** Rules for MIME types, checked in order; the first hit wins. */
const BY_MIME = [
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

function kindFromMime(mimeType) {
  if (!mimeType) return 'generic';
  // An RFC 6839 suffix names the container, not the content: atom+xml is a
  // feed, not code, and usdz+zip is a 3D model, not an archive.
  const essence = String(mimeType).toLowerCase().split(';')[0].trim();
  const mime = essence.replace(/\+[a-z0-9-]+$/, '');
  for (const [test, kind] of BY_MIME) if (test(mime)) return kind;
  return 'generic';
}

/** The lowercase extension without its dot; a leading dot is a hidden file's name, not an extension. */
function extensionOf(name) {
  const dot = (name || '').lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function getFileKind(name, storedMimeType) {
  const ext = extensionOf(name);
  if (!ext) return kindFromMime(storedMimeType);
  return BY_EXTENSION.get(ext) ?? kindFromMime(mimeTypes.lookup(ext) || '');
}

export { extensionOf, getFileKind };
