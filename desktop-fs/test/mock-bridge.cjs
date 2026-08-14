#!/usr/bin/env node
/*
 * Standalone mock of the Electron fsbridge for exercising the WinFsp provider
 * without a backend or a logged-in session. It speaks the exact same
 * newline-delimited JSON-RPC protocol over a named pipe and backs it with an
 * in-memory tree, using real temp files for download/upload just like the real
 * bridge. Lets us prove the native filesystem end-to-end (mount, list, read,
 * write, mkdir, rename, move, delete) in isolation.
 *
 * Usage: node mock-bridge.cjs <pipeName>
 */
'use strict';

const net = require('net');
const fs = require('fs');

const pipeName = process.argv[2] || `tma-cloud-fs-mock-${process.pid}`;
const pipePath = `\\\\.\\pipe\\${pipeName}`;

// -------- in-memory tree --------
let seq = 1;
const newId = () => 'id' + seq++;

// node: { id, name, type:'file'|'folder', size, modified, accessed?, parentId, content:Buffer|null }
const nodes = new Map();
const root = { id: null, name: '', type: 'folder', parentId: undefined };

// Fixed timestamps for the seeded entries so the mount test can assert exact
// values. Deliberately far apart, and both in the past, so a wrong mapping
// (access falling back to write, or to the current clock) is unmistakable.
const SEED_MODIFIED = Date.parse('2026-01-02T03:04:05.000Z');
const SEED_ACCESSED = Date.parse('2026-03-04T05:06:07.000Z');

function childrenOf(parentId) {
  const out = [];
  for (const n of nodes.values()) if (n.parentId === (parentId || null)) out.push(n);
  return out;
}
function listPayload(parentId) {
  return childrenOf(parentId).map(n => {
    const row = {
      id: n.id,
      name: n.name,
      type: n.type,
      // Return size as a STRING to mirror node-postgres serializing BIGINT
      // columns as strings — the real backend does this.
      size: String(n.type === 'folder' ? 0 : (n.content ? n.content.length : 0)),
      modified: new Date(n.modified || Date.now()).toISOString(),
      mimeType: 'application/octet-stream',
    };
    // Omitted entirely when the node has no access time, which is how an
    // older backend answers — the host should fall back to `modified`.
    if (n.accessed) row.accessedAt = new Date(n.accessed).toISOString();
    return row;
  });
}

// seed with a couple of items so a fresh mount shows content
(function seed() {
  const docs = {
    id: newId(), name: 'Documents', type: 'folder', parentId: null,
    modified: SEED_MODIFIED, accessed: SEED_ACCESSED,
  };
  nodes.set(docs.id, docs);
  const hello = {
    id: newId(), name: 'hello.txt', type: 'file', parentId: null,
    modified: SEED_MODIFIED, accessed: SEED_ACCESSED,
    content: Buffer.from('Hello from TMA Cloud!\r\n'),
  };
  nodes.set(hello.id, hello);
  // No `accessed`: exercises the fallback for backends that never send one.
  const readme = {
    id: newId(), name: 'readme.md', type: 'file', parentId: docs.id,
    modified: SEED_MODIFIED, content: Buffer.from('# Inside Documents\r\n'),
  };
  nodes.set(readme.id, readme);
})();

function log(...a) { console.error('[mock]', ...a); }

const handlers = {
  list: (m) => listPayload(m.parentId || null),

  // Mirror the real backend: total/used as strings (BIGINT). 2 GB used of 500 GB.
  stats: () => ({ used: String(2 * 1024 ** 3), total: String(500 * 1024 ** 3), free: String(498 * 1024 ** 3) }),

  download: (m) => {
    const n = nodes.get(m.id);
    if (!n) throw new Error('not found: ' + m.id);
    fs.writeFileSync(m.dest, n.content || Buffer.alloc(0));
    return { ok: true, size: n.content ? n.content.length : 0 };
  },

  upload: (m) => {
    const content = fs.readFileSync(m.src);
    const node = {
      id: newId(), name: m.name, type: 'file',
      parentId: m.parentId || null, modified: Date.now(), content,
    };
    nodes.set(node.id, node);
    return { id: node.id, name: node.name, type: 'file', size: content.length };
  },

  replace: (m) => {
    const n = nodes.get(m.id);
    if (!n) throw new Error('not found: ' + m.id);
    n.content = fs.readFileSync(m.src);
    n.modified = Date.now();
    return { id: n.id, size: n.content.length };
  },

  mkdir: (m) => {
    const node = {
      id: newId(), name: m.name, type: 'folder',
      parentId: m.parentId || null, modified: Date.now(),
    };
    nodes.set(node.id, node);
    return { id: node.id, name: node.name, type: 'folder', size: 0 };
  },

  rename: (m) => {
    const n = nodes.get(m.id);
    if (!n) throw new Error('not found: ' + m.id);
    n.name = m.name;
    n.modified = Date.now();
    return { id: n.id, name: n.name };
  },

  move: (m) => {
    for (const id of m.ids || []) {
      const n = nodes.get(id);
      if (n) n.parentId = m.parentId || null;
    }
    return { ok: true };
  },

  delete: (m) => {
    for (const id of m.ids || []) {
      // recursively remove folder subtrees
      const stack = [id];
      while (stack.length) {
        const cur = stack.pop();
        for (const c of childrenOf(cur)) stack.push(c.id);
        nodes.delete(cur);
      }
    }
    return { ok: true };
  },
};

function handleLine(sock, line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { rid, op } = msg;
  const reply = (obj) => { try { sock.write(JSON.stringify({ rid, ...obj }) + '\n'); } catch {} };
  try {
    const h = handlers[op];
    if (!h) throw new Error('unknown op: ' + op);
    const result = h(msg);
    log(op, JSON.stringify(msg).slice(0, 120), '->', 'ok');
    reply({ ok: true, result });
  } catch (err) {
    log(op, 'ERROR', err.message);
    reply({ ok: false, error: err.message });
  }
}

const server = net.createServer((sock) => {
  // Optional push test hooks (2s after the host connects), for verifying the
  // server->client push channel:
  //   TMA_MOCK_MODE_PUSH  - push mode=saveonly (reads should start denying)
  //   TMA_MOCK_PUSH_TEST  - inject a new file + invalidate push (should appear
  //                         before the listing TTL, proving live invalidation)
  if (process.env.TMA_MOCK_MODE_PUSH) {
    setTimeout(() => {
      log('sending mode=saveonly push');
      try { sock.write(JSON.stringify({ push: 'mode', mode: 'saveonly' }) + '\n'); } catch {}
    }, 2000);
  }
  if (process.env.TMA_MOCK_PUSH_TEST) {
    setTimeout(() => {
      const n = {
        id: newId(), name: 'pushed.txt', type: 'file', parentId: null,
        modified: Date.now(), content: Buffer.from('appeared via push'),
      };
      nodes.set(n.id, n);
      log('injected pushed.txt and sending invalidate push');
      try { sock.write(JSON.stringify({ push: 'invalidate' }) + '\n'); } catch {}
    }, 2000);
  }
  sock.setEncoding('utf8');
  let buf = '';
  sock.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) handleLine(sock, line);
    }
  });
  sock.on('error', () => {});
});

server.on('error', (e) => { log('server error', e.message); process.exit(1); });
server.listen(pipePath, () => log('listening on', pipePath));
