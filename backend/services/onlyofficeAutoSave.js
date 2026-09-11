import http from 'http';
import https from 'https';
import jwt from 'jsonwebtoken';

import { logger } from '../config/logger.js';
import { getOnlyOfficeConfig } from '../controllers/onlyoffice/onlyoffice.utils.js';
import { getBoss } from './auditLogger.js';
import { ONLYOFFICE_FORCESAVE_QUEUE } from './backgroundQueue.js';

const configuredInterval = Number(process.env.ONLYOFFICE_AUTOSAVE_INTERVAL_MS);
const configuredMinutes = configuredInterval / 60000;
// Cron steps repeat evenly only when the interval divides an hour. Reject an
// imprecise override instead of silently producing uneven save gaps.
const intervalMinutes =
  Number.isInteger(configuredMinutes) &&
  configuredMinutes >= 1 &&
  configuredMinutes <= 60 &&
  60 % configuredMinutes === 0
    ? configuredMinutes
    : 5;
const forceSaveCron = intervalMinutes === 60 ? '0 * * * *' : `*/${intervalMinutes} * * * *`;
const commandServicePaths = new Map();

/** Register one durable, de-duplicated schedule per open document. */
async function registerOpenDocument(documentKey, fileId, userId) {
  const boss = getBoss();
  if (!boss) {
    logger.warn({ documentKey }, '[ONLYOFFICE-AUTOSAVE] Queue unavailable; document was not scheduled');
    return;
  }
  try {
    await boss.schedule(
      ONLYOFFICE_FORCESAVE_QUEUE,
      forceSaveCron,
      { documentKey, fileId, userId },
      { key: documentKey, singletonKey: documentKey, tz: 'UTC' }
    );
  } catch (error) {
    logger.warn({ err: error, documentKey }, '[ONLYOFFICE-AUTOSAVE] Failed to schedule document');
  }
}

/** Remove a document's recurring schedule after ONLYOFFICE reports close. */
async function unregisterOpenDocument(documentKey) {
  const boss = getBoss();
  if (!boss) return;
  try {
    await boss.unschedule(ONLYOFFICE_FORCESAVE_QUEUE, documentKey);
  } catch (error) {
    logger.warn({ err: error, documentKey }, '[ONLYOFFICE-AUTOSAVE] Failed to remove document schedule');
  }
}

function sendCommand(config, documentKey, postData, servicePath) {
  const urlObj = new URL(`${config.url}${servicePath}`);
  // Recommended by ONLYOFFICE since 8.1 for correct routing in sharded setups.
  urlObj.searchParams.set('shardkey', documentKey);
  const protocol = urlObj.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = protocol.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
        timeout: 5000,
        rejectUnauthorized: process.env.ONLYOFFICE_REJECT_UNAUTHORIZED !== 'false',
      },
      res => {
        let data = '';
        res.on('data', chunk => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, data });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('ONLYOFFICE force-save timed out')));
    req.end(postData);
  });
}

/** Execute one force-save command. Called only by the standalone worker. */
async function forceSaveDocument(documentKey) {
  const config = await getOnlyOfficeConfig();
  if (!config.url) throw new Error('ONLYOFFICE URL is not configured');

  const commandPayload = { c: 'forcesave', key: documentKey };
  const requestBody = config.jwtSecret
    ? { token: jwt.sign(commandPayload, config.jwtSecret, { algorithm: 'HS256' }) }
    : commandPayload;
  const postData = JSON.stringify(requestBody);

  let servicePath = commandServicePaths.get(config.url) || '/command';
  let result = await sendCommand(config, documentKey, postData, servicePath);
  if (result.statusCode === 404 && servicePath === '/command') {
    // ONLYOFFICE Docs before 8.2 exposes the same supported command service at
    // its legacy path. Remember the fallback for the rest of this worker run.
    servicePath = '/coauthoring/CommandService.ashx';
    commandServicePaths.set(config.url, servicePath);
    result = await sendCommand(config, documentKey, postData, servicePath);
  }
  if (result.statusCode !== 200) throw new Error(`ONLYOFFICE command returned HTTP ${result.statusCode}`);

  let response;
  try {
    response = JSON.parse(result.data);
  } catch (error) {
    throw new Error('ONLYOFFICE command returned invalid JSON', { cause: error });
  }
  if (response.error === 1) return { closed: true };
  if (response.error === 4) return { noChanges: true };
  if (response.error) throw new Error(`ONLYOFFICE force-save error ${response.error}`);
  return { saved: true };
}

export { registerOpenDocument, unregisterOpenDocument, forceSaveDocument };
