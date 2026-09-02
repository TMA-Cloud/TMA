/**
 * HTML escaping function to prevent XSS
 * Uses escape-html package for better performance and correctness
 */
import escapeHtml from 'escape-html';

/**
 * Shared <head> boilerplate for the public share pages: charset, viewport,
 * and a theme-aware design system driven entirely by CSS custom properties so
 * light/dark is a single media-query swap. No client JS, no external requests —
 * the whole page is one server response.
 */
const BASE_STYLE = `
  *{box-sizing:border-box}
  :root{
    --bg:#f6f7f9;--panel:#fff;--border:#e6e8eb;--row-hover:#f2f4f7;
    --text:#1f2328;--muted:#6b7280;--accent:#2563eb;--accent-contrast:#fff;
    --shadow:0 1px 2px rgba(16,24,40,.04),0 4px 16px rgba(16,24,40,.06);
    --radius:14px;
  }
  @media (prefers-color-scheme:dark){
    :root{
      --bg:#0d1117;--panel:#161b22;--border:#2a2f37;--row-hover:#1c222b;
      --text:#e6edf3;--muted:#9aa4b2;--accent:#4d8bff;--accent-contrast:#0d1117;
      --shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.35);
    }
  }
  html{-webkit-text-size-adjust:100%}
  body{
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    margin:0;background:var(--bg);color:var(--text);line-height:1.5;
    padding:32px 16px;
  }
  .wrap{max-width:720px;margin:0 auto}
  .crumbs{display:flex;align-items:center;flex-wrap:wrap;gap:2px;margin-bottom:14px;font-size:13px}
  .crumbs a{color:var(--muted);text-decoration:none;padding:2px 4px;border-radius:6px}
  .crumbs a:hover{color:var(--accent);background:var(--row-hover)}
  .crumbs span[aria-current]{color:var(--text);font-weight:550;padding:2px 4px}
  .crumb-sep{width:14px;height:14px;color:var(--muted);opacity:.6;flex:none}
  .head{display:flex;align-items:flex-start;gap:16px;margin-bottom:20px;flex-wrap:wrap}
  .head .title{display:flex;align-items:center;gap:12px;min-width:0;flex:1 1 260px}
  .head .title svg{width:34px;height:34px;color:var(--accent);flex:none}
  .head h1{font-size:20px;font-weight:650;margin:0;overflow-wrap:anywhere}
  .head .sub{color:var(--muted);font-size:13px;margin-top:2px}
  .dl-all{
    display:inline-flex;align-items:center;gap:8px;flex:none;
    background:var(--accent);color:var(--accent-contrast);text-decoration:none;
    font-size:14px;font-weight:550;padding:9px 16px;border-radius:10px;
    transition:filter .15s ease;
  }
  .dl-all:hover{filter:brightness(1.06)}
  .dl-all svg{width:16px;height:16px}
  .list{
    background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);
    box-shadow:var(--shadow);overflow:hidden;
  }
  .row{
    display:flex;align-items:center;gap:14px;padding:13px 16px;
    text-decoration:none;color:inherit;border-top:1px solid var(--border);
    transition:background .12s ease;
  }
  .row:first-child{border-top:0}
  .row:hover,.row:focus-visible{background:var(--row-hover);outline:none}
  .row:focus-visible{box-shadow:inset 0 0 0 2px var(--accent)}
  .ic{width:22px;height:22px;flex:none;color:var(--muted)}
  .ic.folder{color:var(--accent)}
  .meta{min-width:0;flex:1;display:flex;flex-direction:column}
  .name{font-size:14.5px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .size{color:var(--muted);font-size:12.5px;margin-top:1px}
  .go{width:18px;height:18px;flex:none;color:var(--muted);opacity:.55;transition:opacity .12s ease,transform .12s ease}
  .row:hover .go{opacity:1;transform:translateX(2px)}
  .empty{padding:48px 16px;text-align:center;color:var(--muted);font-size:14px}
  .foot{color:var(--muted);font-size:12px;text-align:center;margin-top:18px}
  .filecard{
    background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);
    box-shadow:var(--shadow);padding:40px 28px;text-align:center;
  }
  .fc-icon{width:64px;height:64px;margin:0 auto 18px;color:var(--accent)}
  .fc-icon svg{width:64px;height:64px}
  .filecard h1{font-size:19px;font-weight:650;margin:0 0 6px;overflow-wrap:anywhere}
  .filecard .sub{color:var(--muted);font-size:13px;margin:0 0 22px}
  .filecard .dl-all{font-size:15px;padding:11px 22px}
`;

/**
 * One inline SVG sprite, defined once and referenced by every row via <use>.
 * Cheaper than repeating path data per item and keeps icons crisp at any DPI.
 */
const ICON_SPRITE = `<svg width="0" height="0" style="position:absolute" aria-hidden="true">
<symbol id="i-folder" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></symbol>
<symbol id="i-file" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M6 2h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z"/><path d="M14 2v5h5"/></symbol>
<symbol id="i-image" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-4 4 3 3-2 4 3"/></symbol>
<symbol id="i-video" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3Z"/></symbol>
<symbol id="i-audio" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></symbol>
<symbol id="i-pdf" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M6 2h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z"/><path d="M14 2v5h5"/><path d="M8 13h1.5a1.5 1.5 0 0 1 0 3H8Zm0 3v2m8-5v5m0-3h1.6M12 13v5"/></symbol>
<symbol id="i-sheet" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16M15 4v16"/></symbol>
<symbol id="i-archive" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M12 3v3m0 2v2m0 2v2"/><rect x="10" y="14" width="4" height="4" rx="1"/></symbol>
<symbol id="i-code" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="m9 8-4 4 4 4m6-8 4 4-4 4"/></symbol>
<symbol id="i-doc" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M6 2h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z"/><path d="M14 2v5h5"/><path d="M8 12h8M8 15h8M8 18h5"/></symbol>
<symbol id="i-download" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v10m0 0 4-4m-4 4-4-4M5 19h14"/></symbol>
<symbol id="i-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></symbol>
</svg>`;

/**
 * Minimal, self-contained HTML error page for public share endpoints.
 */
function renderErrorPage(res, status, title, message) {
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${BASE_STYLE}
  body{display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{text-align:center;max-width:420px}
  .card h1{font-size:22px;margin:0 0 8px}
  .card p{color:var(--muted);margin:0}
</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div></body></html>`;
  res.status(status).send(html);
}

/** Bytes → short human-readable string (e.g. "1.4 MB"). */
function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const val = n / 1024 ** i;
  return `${i === 0 ? val : val.toFixed(val >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Map a file's mime type / extension to one of the sprite symbol ids. */
function iconIdFor(item) {
  if (item.type === 'folder') return 'i-folder';
  const mime = (item.mimeType || '').toLowerCase();
  const name = (item.name || '').toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';

  if (mime.startsWith('image/')) return 'i-image';
  if (mime.startsWith('video/')) return 'i-video';
  if (mime.startsWith('audio/')) return 'i-audio';
  if (mime === 'application/pdf' || ext === 'pdf') return 'i-pdf';
  if (/(sheet|excel|csv)/.test(mime) || ['xlsx', 'xls', 'csv', 'tsv', 'ods'].includes(ext)) return 'i-sheet';
  if (/(zip|compressed|tar|rar|7z|gzip)/.test(mime) || ['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) {
    return 'i-archive';
  }
  if (/(word|document|opendocument\.text|rtf)/.test(mime) || ['doc', 'docx', 'rtf', 'odt', 'txt', 'md'].includes(ext)) {
    return 'i-doc';
  }
  const code = [
    'js',
    'ts',
    'jsx',
    'tsx',
    'json',
    'html',
    'css',
    'py',
    'java',
    'c',
    'cpp',
    'go',
    'rs',
    'sh',
    'yml',
    'yaml',
    'xml',
  ];
  if (code.includes(ext)) return 'i-code';
  return 'i-file';
}

/** SVG icon reference into the shared sprite. */
function icon(id, cls) {
  return `<svg class="${cls}" aria-hidden="true"><use href="#${id}"/></svg>`;
}

/** Human label for a file's kind, e.g. "PDF · Document", "PNG · Image". */
const KIND_LABELS = {
  'i-image': 'Image',
  'i-video': 'Video',
  'i-audio': 'Audio',
  'i-pdf': 'Document',
  'i-sheet': 'Spreadsheet',
  'i-archive': 'Archive',
  'i-doc': 'Document',
  'i-code': 'Code',
  'i-file': 'File',
};
function kindLabel(item) {
  const label = KIND_LABELS[iconIdFor(item)] || 'File';
  const name = (item.name || '').toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toUpperCase() : '';
  return ext ? `${ext} · ${label}` : label;
}

/** Breadcrumb trail from the shared root down to the current folder. */
function renderCrumbs(trail, t) {
  if (!trail || trail.length < 2) return '';
  const crumbs = trail
    .map((node, i) => {
      const name = escapeHtml(node.name);
      if (i === trail.length - 1) return `<span aria-current="page">${name}</span>`;
      const href = i === 0 ? `/s/${t}` : `/s/${t}/folder/${escapeHtml(node.id)}`;
      return `<a href="${href}">${name}</a>`;
    })
    .join(`${icon('i-chevron', 'crumb-sep')}`);
  return `<nav class="crumbs" aria-label="Breadcrumb">${crumbs}</nav>`;
}

/**
 * Render the public folder-listing page for a share link — either the shared
 * root or a subfolder browsed into. Server-rendered, single response, no JS.
 *
 * @param {Array}  items   Rows in this folder (already scoped to the share).
 * @param {string} token   Share token.
 * @param {object} opts
 * @param {string} opts.heading  Current folder name.
 * @param {Array}  opts.trail    [{id,name}] root → current, for breadcrumbs.
 * @param {string} opts.zipHref  URL that zips the current folder.
 */
function renderFolderPage(items, token, { heading, trail, zipHref }) {
  const t = escapeHtml(token);
  const title = escapeHtml(heading);

  const fileCount = items.filter(i => i.type !== 'folder').length;
  const folderCount = items.length - fileCount;
  const totalBytes = items.reduce((sum, i) => sum + (Number(i.size) || 0), 0);

  const parts = [];
  if (folderCount) parts.push(`${folderCount} folder${folderCount > 1 ? 's' : ''}`);
  if (fileCount) parts.push(`${fileCount} file${fileCount > 1 ? 's' : ''}`);
  const totalStr = formatBytes(totalBytes);
  if (totalStr) parts.push(totalStr);
  const subtitle = parts.join(' · ') || 'Empty folder';

  const rows = items
    .map(item => {
      const id = escapeHtml(item.id);
      const isFolder = item.type === 'folder';
      // Folders navigate in; files download directly.
      const href = isFolder ? `/s/${t}/folder/${id}` : `/s/${t}/file/${id}`;
      const meta = isFolder ? 'Folder' : formatBytes(item.size);
      return `<a class="row" href="${href}"${isFolder ? '' : ' download'}>
        ${icon(iconIdFor(item), `ic${isFolder ? ' folder' : ''}`)}
        <span class="meta"><span class="name">${escapeHtml(item.name)}</span>${meta ? `<span class="size">${escapeHtml(meta)}</span>` : ''}</span>
        ${icon(isFolder ? 'i-chevron' : 'i-download', 'go')}
      </a>`;
    })
    .join('');

  const body = items.length
    ? `<div class="list">${rows}</div>`
    : `<div class="list"><div class="empty">This shared folder is empty.</div></div>`;

  const downloadAll = items.length
    ? `<a class="dl-all" href="${escapeHtml(zipHref)}">${icon('i-download', '')}<span>Download all</span></a>`
    : '';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${BASE_STYLE}</style></head>
<body>${ICON_SPRITE}
<div class="wrap">
  ${renderCrumbs(trail, t)}
  <header class="head">
    <div class="title">${icon('i-folder', '')}<div><h1>${title}</h1><div class="sub">${escapeHtml(subtitle)}</div></div></div>
    ${downloadAll}
  </header>
  ${body}
  <p class="foot">Shared securely · files are served on demand</p>
</div>
</body></html>`;
}

/**
 * Landing page for a single shared file: a file card with a download button.
 * The button points at the shared-item stream route so the actual download
 * keeps its own access checks and Content-Disposition.
 */
function renderFilePage(file, token) {
  const t = escapeHtml(token);
  const id = escapeHtml(file.id);
  const name = escapeHtml(file.name);

  const size = formatBytes(file.size);
  const meta = [size, kindLabel(file)].filter(Boolean).join(' · ');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name}</title>
<style>${BASE_STYLE}</style></head>
<body>${ICON_SPRITE}
<div class="wrap">
  <div class="filecard">
    <div class="fc-icon">${icon(iconIdFor(file), '')}</div>
    <h1>${name}</h1>
    <p class="sub">${escapeHtml(meta)}</p>
    <a class="dl-all" href="/s/${t}/file/${id}" download>${icon('i-download', '')}<span>Download</span></a>
  </div>
  <p class="foot">Shared securely on demand</p>
</div>
</body></html>`;
}

export { escapeHtml, renderErrorPage, renderFolderPage, renderFilePage };
