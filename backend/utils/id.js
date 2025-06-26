const crypto = require('crypto');
const base58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function generateId(length) {
  const bytes = crypto.randomBytes(length);
  let id = '';
  for (let i = 0; i < length; i++) {
    id += base58[bytes[i] % 58];
  }
  return id;
}

module.exports = { generateId };
