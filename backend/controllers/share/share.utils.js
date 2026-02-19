/**
 * HTML escaping function to prevent XSS
 * Uses escape-html package for better performance and correctness
 */
const escapeHtml = require('escape-html');

/**
 * Minimal, self-contained HTML error page for public share endpoints.
 */
function renderErrorPage(res, status, title, message) {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f9fafb;color:#374151}
  .card{text-align:center;padding:3rem 2rem;max-width:420px}
  h1{font-size:1.5rem;margin:0 0 .75rem}
  p{color:#6b7280;margin:0;line-height:1.6}
</style></head>
<body><div class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div></body></html>`;
  res.status(status).send(html);
}

module.exports = {
  escapeHtml,
  renderErrorPage,
};
