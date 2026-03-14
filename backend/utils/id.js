/**
 * ID generation utility using nanoid
 * Replaces custom base58 implementation with faster, more robust nanoid
 */

import { customAlphabet } from 'nanoid';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const DEFAULT_LENGTH = 16;
const nanoid = customAlphabet(ALPHABET, DEFAULT_LENGTH);

/**
 * Generate a random ID
 * @param {number} length - Length of the ID (default: 16)
 * @returns {string} Random ID
 */
function generateId(length = DEFAULT_LENGTH) {
  return nanoid(length);
}

export { generateId };
