/**
 * ID generation utility using nanoid
 * Replaces custom base58 implementation with faster, more robust nanoid
 */

const { customAlphabet } = require('nanoid');

/**
 * Generate a random ID
 * @param {number} length - Length of the ID (default: 16)
 * @returns {string} Random ID
 */
function generateId(length = 16) {
  // nanoid uses URL-safe characters and is faster than custom base58
  // Custom alphabet to match base58 style (no 0, O, I, l to avoid confusion)
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const nanoid = customAlphabet(alphabet, length);
  return nanoid();
}

module.exports = { generateId };
