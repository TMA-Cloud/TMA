/**
 * In-memory stand-in for config/redis.js.
 *
 * This is a working fake rather than a stub: GET/SETEX/DEL/SCAN/PUBLISH all
 * behave like the real thing (including SCAN's cursor protocol and per-key
 * TTLs), so utils/cache.js is exercised for real instead of being mocked away.
 */

import { vi } from 'vitest';

/** key -> { value: string, expiresAt: number | null } */
const store = new Map();
/** channel -> Set<(message, channel) => void> */
const subscribers = new Map();
const sets = new Map();
const sortedSets = new Map();
/** Every publish, for assertions. */
const published = [];

let isConnected = false;
let connectionError = null;
/** Forces isRedisConnected() to report false without touching the store. */
let forcedDown = false;

function now() {
  return Date.now();
}

function isExpired(entry) {
  return entry.expiresAt !== null && entry.expiresAt <= now();
}

function readEntry(key) {
  const entry = store.get(key);
  if (!entry) return null;
  if (isExpired(entry)) {
    store.delete(key);
    return null;
  }
  return entry;
}

/** Translate a Redis glob pattern (* ? [abc]) into a RegExp. */
function globToRegExp(pattern) {
  let out = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else if (ch === '[') {
      const end = pattern.indexOf(']', i);
      if (end === -1) {
        out += '\\[';
      } else {
        out += `[${pattern.slice(i + 1, end)}]`;
        i = end;
      }
    } else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${out}$`);
}

const redisClient = {
  get isReady() {
    return isConnected && !forcedDown;
  },

  connect: vi.fn(async () => {
    isConnected = true;
    return redisClient;
  }),

  quit: vi.fn(async () => {
    isConnected = false;
  }),

  on: vi.fn(() => redisClient),

  get: vi.fn(async key => {
    const entry = readEntry(key);
    return entry ? entry.value : null;
  }),

  set: vi.fn(async (key, value) => {
    store.set(key, { value: String(value), expiresAt: null });
    return 'OK';
  }),

  setEx: vi.fn(async (key, ttlSeconds, value) => {
    store.set(key, { value: String(value), expiresAt: now() + ttlSeconds * 1000 });
    return 'OK';
  }),

  mGet: vi.fn(async keys => Promise.all(keys.map(key => redisClient.get(key)))),

  unlink: vi.fn(async keys => redisClient.del(keys)),

  zAdd: vi.fn(async (key, entries) => {
    if (!sortedSets.has(key)) sortedSets.set(key, new Map());
    const target = sortedSets.get(key);
    const list = Array.isArray(entries) ? entries : [entries];
    let added = 0;
    for (const entry of list) {
      if (!target.has(entry.value)) added += 1;
      target.set(entry.value, Number(entry.score));
    }
    return added;
  }),

  zRangeByScore: vi.fn(async (key, min, max) => {
    const low = min === '-inf' ? -Infinity : Number(min);
    const high = max === '+inf' ? Infinity : Number(max);
    return [...(sortedSets.get(key) || new Map()).entries()]
      .filter(([, score]) => score >= low && score <= high)
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .map(([member]) => member);
  }),

  zRemRangeByScore: vi.fn(async (key, min, max) => {
    const target = sortedSets.get(key);
    if (!target) return 0;
    const low = min === '-inf' ? -Infinity : Number(min);
    const high = max === '+inf' ? Infinity : Number(max);
    let removed = 0;
    for (const [member, score] of target) {
      if (score >= low && score <= high) {
        target.delete(member);
        removed += 1;
      }
    }
    return removed;
  }),

  zRem: vi.fn(async (key, members) => {
    const target = sortedSets.get(key);
    if (!target) return 0;
    let removed = 0;
    for (const member of Array.isArray(members) ? members : [members]) {
      if (target.delete(member)) removed += 1;
    }
    return removed;
  }),

  multi: vi.fn(() => {
    const actions = [];
    const batch = {
      setEx(key, ttl, value) {
        actions.push(() => redisClient.setEx(key, ttl, value));
        return batch;
      },
      zAdd(key, entries) {
        actions.push(() => redisClient.zAdd(key, entries));
        return batch;
      },
      zRemRangeByScore(key, min, max) {
        actions.push(() => redisClient.zRemRangeByScore(key, min, max));
        return batch;
      },
      expire(key, ttl) {
        actions.push(() => redisClient.expire(key, ttl));
        return batch;
      },
      async exec() {
        return Promise.all(actions.map(action => action()));
      },
    };
    return batch;
  }),

  sAdd: vi.fn(async (key, ...members) => {
    if (!sets.has(key)) sets.set(key, new Set());
    const target = sets.get(key);
    let added = 0;
    for (const member of members.flat()) {
      if (!target.has(member)) added += 1;
      target.add(member);
    }
    return added;
  }),

  sMembers: vi.fn(async key => [...(sets.get(key) || [])]),

  expire: vi.fn(async () => 1),

  ttl: vi.fn(async key => {
    const entry = readEntry(key);
    if (!entry) return -2;
    if (entry.expiresAt === null) return -1;
    return Math.ceil((entry.expiresAt - now()) / 1000);
  }),

  del: vi.fn(async keys => {
    const list = Array.isArray(keys) ? keys : [keys];
    let deleted = 0;
    for (const key of list) {
      sets.delete(key);
      sortedSets.delete(key);
      if (readEntry(key) !== null) {
        store.delete(key);
        deleted++;
      } else {
        store.delete(key);
      }
    }
    return deleted;
  }),

  exists: vi.fn(async key => (readEntry(key) !== null ? 1 : 0)),

  /**
   * Cursor-based iteration, matching node-redis v5+: the cursor is a *string*
   * and '0' terminates the loop. Returning a number here would spin cache.js
   * forever, so the type matters.
   */
  scan: vi.fn(async (cursor, options = {}) => {
    const start = Number(cursor) || 0;
    const count = options.COUNT || 10;
    const matcher = options.MATCH ? globToRegExp(options.MATCH) : null;

    const allKeys = [...store.keys()].filter(k => readEntry(k) !== null);
    const slice = allKeys.slice(start, start + count);
    const nextCursor = start + count >= allKeys.length ? '0' : String(start + count);

    return {
      cursor: nextCursor,
      keys: matcher ? slice.filter(k => matcher.test(k)) : slice,
    };
  }),

  publish: vi.fn(async (channel, message) => {
    published.push({ channel, message });
    const handlers = subscribers.get(channel);
    if (!handlers) return 0;
    for (const handler of handlers) handler(message, channel);
    return handlers.size;
  }),

  subscribe: vi.fn(async (channel, handler) => {
    if (!subscribers.has(channel)) subscribers.set(channel, new Set());
    subscribers.get(channel).add(handler);
  }),

  unsubscribe: vi.fn(async channel => {
    if (channel === undefined) subscribers.clear();
    else subscribers.delete(channel);
  }),

  /** Pub/sub needs its own connection; hand back an independent fake. */
  duplicate: vi.fn(() => {
    const dup = { ...redisClient, isReady: true };
    dup.connect = vi.fn(async () => dup);
    dup.quit = vi.fn(async () => {});
    dup.on = vi.fn(() => dup);
    return dup;
  }),
};

async function connectRedis() {
  isConnected = true;
  connectionError = null;
  return redisClient;
}

async function disconnectRedis() {
  isConnected = false;
}

function isRedisConnected() {
  return isConnected && !forcedDown;
}

function getConnectionError() {
  return connectionError;
}

/* ------------------------------------------------------------------ *
 * Test-facing controls
 * ------------------------------------------------------------------ */

/** Pretend Redis is unreachable so degraded-mode branches can be exercised. */
function setRedisDown(down = true) {
  forcedDown = down;
}

/** Raw view of the in-memory store, for assertions. */
function redisStore() {
  return store;
}

/** Everything published since the last reset. */
function publishedMessages() {
  return [...published];
}

/** Seed a key directly, bypassing the client. */
function seedRedis(key, value, ttlSeconds = null) {
  store.set(key, {
    value: typeof value === 'string' ? value : JSON.stringify(value),
    expiresAt: ttlSeconds === null ? null : now() + ttlSeconds * 1000,
  });
}

/** Clear data, subscriptions and publish log; reconnect. */
function resetRedisMock() {
  store.clear();
  sets.clear();
  sortedSets.clear();
  subscribers.clear();
  published.length = 0;
  forcedDown = false;
  isConnected = true;
  connectionError = null;
}

// Tests import modules that assume a live connection; start connected.
isConnected = true;

export { redisClient, connectRedis, disconnectRedis, isRedisConnected, getConnectionError };
export { setRedisDown, redisStore, publishedMessages, seedRedis, resetRedisMock };
