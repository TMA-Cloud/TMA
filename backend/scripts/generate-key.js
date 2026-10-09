/**
 * Print a new random master key for FILE_ENCRYPTION_KEY (32 bytes, base64).
 *
 * Usage (from backend directory):
 *   npm run key:generate
 */

import { generateKey } from '../utils/fileEncryption/keySource.js';

console.log(generateKey());
