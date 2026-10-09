/**
 * Edit `.env` and key files for the rotate command. Writes go to a temporary
 * file in the same directory, then replace the target, so a crash leaves the
 * old file or the new one, never half of each.
 */

import fs from 'fs';
import path from 'path';

/**
 * Set `KEY=value` in .env text, replacing the first active line for the key or
 * appending one. Commented-out lines are left alone.
 * @param {string} text
 * @param {string} key
 * @param {string} value
 * @returns {string}
 */
function setEnvValue(text, key, value) {
  const line = new RegExp(`^${key}=.*$`, 'm');
  if (line.test(text)) return text.replace(line, () => `${key}=${value}`);
  const separator = text === '' || text.endsWith('\n') ? '' : '\n';
  return `${text}${separator}${key}=${value}\n`;
}

/** True when .env text has an active line for the key. */
function hasEnvValue(text, key) {
  return new RegExp(`^${key}=`, 'm').test(text);
}

/**
 * Replace a file atomically, keeping its permission bits.
 * @param {string} target
 * @param {string} content
 */
function writeFileAtomic(target, content) {
  const { mode } = fs.statSync(target);
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temp, content, { mode: mode & 0o777, flag: 'wx' });
    fs.renameSync(temp, target);
  } catch (err) {
    fs.rmSync(temp, { force: true });
    throw err;
  }
}

export { setEnvValue, hasEnvValue, writeFileAtomic };
