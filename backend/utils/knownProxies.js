import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_KNOWN_PROXIES = 100;
const MAX_PROXY_LENGTH = 253;
const HOSTNAME_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function isValidCidr(value) {
  const separator = value.lastIndexOf('/');
  if (separator < 1) return false;

  const address = value.slice(0, separator);
  const prefix = Number(value.slice(separator + 1));
  const family = isIP(address);
  return Number.isInteger(prefix) && prefix >= 0 && ((family === 4 && prefix <= 32) || (family === 6 && prefix <= 128));
}

function normalizeKnownProxies(value) {
  if (!Array.isArray(value)) throw new Error('Known proxies must be an array');
  if (value.length > MAX_KNOWN_PROXIES) {
    throw new Error(`At most ${MAX_KNOWN_PROXIES} known proxies can be configured`);
  }

  const normalized = [];
  for (const rawEntry of value) {
    if (typeof rawEntry !== 'string') throw new Error('Each known proxy must be a string');
    const entry = rawEntry.trim().toLowerCase();
    if (!entry) continue;
    if (entry.length > MAX_PROXY_LENGTH) throw new Error(`Known proxy is too long: ${entry}`);
    const looksLikeInvalidIpv4 = /^[\d.]+$/.test(entry);
    if (!isIP(entry) && !isValidCidr(entry) && (looksLikeInvalidIpv4 || !HOSTNAME_PATTERN.test(entry))) {
      throw new Error(`Invalid proxy IP address, CIDR range, or hostname: ${entry}`);
    }
    if (!normalized.includes(entry)) normalized.push(entry);
  }
  return normalized;
}

async function resolveKnownProxies(entries, resolveHostname = lookup) {
  const resolved = [];
  const failures = [];

  for (const entry of normalizeKnownProxies(entries)) {
    if (isIP(entry) || isValidCidr(entry)) {
      resolved.push(entry);
      continue;
    }

    try {
      const addresses = await resolveHostname(entry, { all: true, verbatim: true });
      for (const { address } of addresses) {
        if (isIP(address) && !resolved.includes(address)) resolved.push(address);
      }
      if (addresses.length === 0) failures.push(entry);
    } catch {
      failures.push(entry);
    }
  }

  return { resolved, failures };
}

export { MAX_KNOWN_PROXIES, normalizeKnownProxies, resolveKnownProxies };
