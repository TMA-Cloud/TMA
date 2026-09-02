/*
 * Stream a file through SHA-256. Used by the desktop-edit watcher to detect
 * whether a saved file actually changed before re-uploading it.
 */
const fs = require('fs');
const crypto = require('crypto');

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);

    stream.on('data', chunk => {
      hash.update(chunk);
    });

    stream.on('error', err => {
      reject(err);
    });

    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });
  });
}

module.exports = { hashFile };
