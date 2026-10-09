// The callback path on this server; Google must be told to send users back to it.
const GOOGLE_CALLBACK_PATH = '/api/google/callback';

/** The redirect URI for a site origin, as it must be registered in Google Cloud. */
export function redirectUriFor(origin: string): string {
  return `${origin.replace(/\/+$/, '')}${GOOGLE_CALLBACK_PATH}`;
}
