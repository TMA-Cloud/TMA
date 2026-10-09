/**
 * Rotate the master key and the database password.
 *
 * Usage (from backend directory):
 *   npm run rotate -- status         Key versions and how many file keys each wraps
 *   npm run rotate -- key            Add a new master key to FILE_ENCRYPTION_KEY(_FILE)
 *   npm run rotate -- rewrap         Rewrap stored file keys under the newest master key
 *   npm run rotate -- db-password    Set a new random database password and save it in .env
 *
 * Docker installs run ./rotate.sh on the host instead, which edits the files the
 * containers mount and calls this script inside the app container.
 *
 * `key` keeps the older keys: data not yet rewrapped and older database backups
 * still need them. After it, restart the API and the worker; the worker rewraps
 * stored file keys on start, or run `rewrap` to do it now and see the result.
 */

import './lib/quietLogs.js';
import { envPath } from '../config/env.js';

import crypto from 'crypto';
import fs from 'fs';

import pg from 'pg';

import pool, { buildPoolConfig } from '../config/db.js';
import { getKekChecks } from '../models/kekCheck.model.js';
import { countKeysByVersion } from '../models/kekRewrap.model.js';
import { verifyEncryptionKeys } from '../services/encryptionKeyCheck.js';
import { rewrapToPrimaryKey } from '../services/kekRewrap.js';
import { formatKeyring, generateKey, readKeyring } from '../utils/fileEncryption/keySource.js';
import { scramSha256Verifier } from '../utils/scram.js';

import { hasEnvValue, setEnvValue, writeFileAtomic } from './lib/envFile.js';

const BACKUP_GUIDE = 'https://tma-cloud.github.io/Wiki/docs/guides/operations/backups';
const MIN_DB_PASSWORD_LENGTH = 16;

class UsageError extends Error {}

function requireKeyring() {
  const keyring = readKeyring();
  if (!keyring) throw new UsageError('FILE_ENCRYPTION_KEY is not set. Generate one with "npm run key:generate".');
  return keyring;
}

async function status() {
  const keyring = requireKeyring();
  const { files, storageSecretVersion, googleSecretVersion } = await countKeysByVersion();
  console.log(`Master key versions: ${[...keyring.keys.keys()].sort((a, b) => a - b).join(', ')}`);
  console.log(`Newest (encrypts new files): ${keyring.primary}`);
  for (const [version, count] of files) console.log(`  version ${version}: ${count} file key(s)`);
  if (storageSecretVersion != null) console.log(`Bucket secret: version ${storageSecretVersion}`);
  if (googleSecretVersion != null) console.log(`Google client secret: version ${googleSecretVersion}`);

  const behind = [...files].filter(([version]) => version !== keyring.primary).reduce((sum, [, n]) => sum + n, 0);
  console.log(
    behind
      ? `${behind} file key(s) still use an older version. The worker rewraps them when it starts.`
      : 'All keys are current.'
  );
  const unused = [...keyring.keys.keys()].filter(
    version =>
      version !== keyring.primary &&
      !files.has(version) &&
      version !== storageSecretVersion &&
      version !== googleSecretVersion
  );
  if (unused.length) {
    console.log(
      `Not used by current data: version ${unused.join(', ')}. Database backups from ` +
        'before a rotation still need them, so remove a line only once you no longer keep those backups.'
    );
  }
}

async function addKey() {
  const keyring = requireKeyring();
  // A new key on top of a wrong one would only hide the problem. A passphrase is
  // fine here: adding a random key is how a deployment moves off one.
  await verifyEncryptionKeys({ allowPassphrasePrimary: true });

  // A version with a check value from an earlier attempt would never match a new key.
  const recorded = await getKekChecks();
  const version = Math.max(keyring.primary, ...recorded.keys()) + 1;
  const keys = new Map(keyring.keys).set(version, generateKey());
  const keyFile = process.env.FILE_ENCRYPTION_KEY_FILE;
  if (keyFile) {
    try {
      writeFileAtomic(keyFile, formatKeyring(keys));
    } catch (err) {
      if (['EACCES', 'EPERM', 'EROFS'].includes(err.code)) {
        throw new UsageError(`${keyFile} is read-only here. On a Docker install, run ./rotate.sh key on the host.`);
      }
      throw err;
    }
    console.log(`Added key version ${version} to ${keyFile}.`);
  } else {
    const text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    if (!hasEnvValue(text, 'FILE_ENCRYPTION_KEY')) {
      throw new UsageError(`FILE_ENCRYPTION_KEY is not set in ${envPath}. Add the new key where it is defined.`);
    }
    const value = [...keys].map(([v, key]) => `${v}:${key}`).join(',');
    writeFileAtomic(envPath, setEnvValue(text, 'FILE_ENCRYPTION_KEY', value));
    console.log(`Added key version ${version} to FILE_ENCRYPTION_KEY in ${envPath}.`);
  }
  console.log('Next:');
  console.log('  1. Restart the API, then the worker. The worker rewraps stored file keys when it starts.');
  console.log('  2. Check progress: npm run rotate -- status');
  console.log(`  3. Back up the key again: ${BACKUP_GUIDE}`);
}

async function rewrap() {
  await verifyEncryptionKeys();
  const result = await rewrapToPrimaryKey({
    onProgress: ({ rewrapped, failed }) => console.log(`Rewrapped ${rewrapped} file key(s), ${failed} failed`),
  });
  if (result.storageSecret) console.log(`Bucket secret rewrapped to version ${result.primary}.`);
  if (result.googleSecret) console.log(`Google client secret rewrapped to version ${result.primary}.`);
  // The worker may have done the work already, so report the end state, not just this run.
  const { files } = await countKeysByVersion();
  const current = files.get(result.primary) ?? 0;
  const older = [...files.values()].reduce((sum, n) => sum + n, 0) - current;
  console.log(
    `This run rewrapped ${result.rewrapped}. ${current} file key(s) use version ${result.primary}, ${older} an older one.`
  );
  if (result.failures.length) {
    for (const failure of result.failures.slice(0, 20)) {
      console.error(`  ${failure.id} (version ${failure.fromVersion}): ${failure.error}`);
    }
    throw new Error(`${result.failures.length} file key(s) could not be rewrapped`);
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function setRolePassword(password) {
  // The server stores the verifier as given, so the password is never sent or logged.
  await pool.query(`ALTER ROLE CURRENT_USER PASSWORD ${pg.escapeLiteral(scramSha256Verifier(password))}`);
}

async function canConnectWith(password) {
  const client = new pg.Client(buildPoolConfig({ password }));
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

async function rotateDbPassword({ fromStdin }) {
  const password = fromStdin ? await readStdin() : crypto.randomBytes(32).toString('hex');
  if (password.length < MIN_DB_PASSWORD_LENGTH) {
    throw new UsageError(`The new password must be at least ${MIN_DB_PASSWORD_LENGTH} characters`);
  }
  const current = process.env.DB_PASSWORD;
  const text = fromStdin ? null : fs.readFileSync(envPath, 'utf8');

  await setRolePassword(password);
  if (!(await canConnectWith(password))) {
    if (current) await setRolePassword(current);
    throw new Error('The database rejected the new password, so the old one was put back. Check pg_hba.conf.');
  }
  console.log('Database password changed.');
  if (fromStdin) return;

  writeFileAtomic(envPath, setEnvValue(text, 'DB_PASSWORD', password));
  console.log(`Saved DB_PASSWORD in ${envPath}. Restart the API and the worker now: new connections need it.`);
}

const COMMANDS = {
  status,
  key: addKey,
  rewrap,
  'db-password': () => rotateDbPassword({ fromStdin: process.argv.includes('--stdin') }),
};

async function main() {
  const command = COMMANDS[process.argv[2]];
  if (!command) throw new UsageError(`Usage: npm run rotate -- <${Object.keys(COMMANDS).join('|')}>`);
  await command();
}

main()
  .catch(err => {
    console.error(err instanceof UsageError ? err.message : `Rotation failed: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
