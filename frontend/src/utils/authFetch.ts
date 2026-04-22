/**
 * Raw `fetch` wrapper that attaches cookie credentials and the
 * X-Requested-With header used for session-based auth endpoints.
 * Use when you need Response-level access (blob/stream/status); for JSON
 * prefer `apiGet`/`apiPost` from `./api`.
 */
export function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('X-Requested-With')) {
    headers.set('X-Requested-With', 'XMLHttpRequest');
  }
  return fetch(input, {
    ...init,
    credentials: init.credentials ?? 'include',
    headers,
  });
}
