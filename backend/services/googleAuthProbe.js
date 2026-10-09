/**
 * Check a Google OAuth client before it is saved, so a typo in the client ID or
 * secret is caught in Settings rather than at the next sign-in.
 *
 * The check redeems a code that cannot exist. The token endpoint authenticates
 * the client before it looks at the code (RFC 6749 section 4.1.3), so a wrong
 * ID or secret answers `invalid_client`, while a valid client gets as far as
 * rejecting the code with `invalid_grant`. Nothing is created at Google and no
 * user is involved. The endpoint is fixed, so no admin input chooses where the
 * request goes.
 */

import { logger } from '../config/logger.js';

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_CODE = 'tma-cloud-credentials-check';

class GoogleAuthProbeError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GoogleAuthProbeError';
    this.status = status;
  }
}

/**
 * @param {{ clientId: string, clientSecret: string, redirectUri: string }} config
 * @throws {GoogleAuthProbeError}
 */
async function verifyGoogleClient({ clientId, clientSecret, redirectUri }) {
  let response;
  try {
    response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: PROBE_CODE,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    logger.warn({ err }, '[GoogleAuth] Could not reach Google to check the client');
    throw new GoogleAuthProbeError('Could not reach Google to check the client ID and secret. Try again.', 502);
  }

  const body = await response.json().catch(() => ({}));
  if (body.error === 'invalid_grant') return;
  if (body.error === 'invalid_client' || body.error === 'unauthorized_client') {
    throw new GoogleAuthProbeError('Google rejected the client ID or secret. Copy both again from Google Cloud.', 400);
  }
  logger.warn({ status: response.status, error: body.error }, '[GoogleAuth] Unexpected answer to the client check');
  throw new GoogleAuthProbeError('Google gave an unexpected answer while checking the client. Try again.', 502);
}

export { GoogleAuthProbeError, verifyGoogleClient };
