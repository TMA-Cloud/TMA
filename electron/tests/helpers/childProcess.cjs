/*
 * Child-process double.
 *
 * Two different subsystems shell out: the clipboard path spawns PowerShell, and
 * the cloud drive spawns the WinFsp host. Both are replaced here so the suite
 * never starts a real process — which would be slow, Windows-only, and would
 * mount an actual drive letter.
 */
'use strict';

const { EventEmitter } = require('events');
const childProcess = require('child_process');

class FakeChildProcess extends EventEmitter {
  constructor(command, args, options) {
    super();
    this.command = command;
    this.args = args;
    this.options = options || {};
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    // Writable enough for callers that hand the child a secret on stdin; what
    // they wrote is kept so tests can assert on it.
    this.stdinChunks = [];
    this.stdinEnded = false;
    this.stdin = Object.assign(new EventEmitter(), {
      write: chunk => {
        this.stdinChunks.push(String(chunk));
        return true;
      },
      end: () => {
        this.stdinEnded = true;
      },
    });
    this.killed = false;
    this.killSignals = [];
  }

  /** Everything written to the child's stdin, joined. */
  stdinText() {
    return this.stdinChunks.join('');
  }

  kill(signal) {
    this.killed = true;
    this.killSignals.push(signal || 'SIGTERM');
    // A terminated process still reports its exit, which callers wait on.
    setImmediate(() => this.exit(1));
    return true;
  }

  /** Emit stdout text as the real process would. */
  emitStdout(text) {
    this.stdout.emit('data', Buffer.from(text));
  }

  emitStderr(text) {
    this.stderr.emit('data', Buffer.from(text));
  }

  /** Finish the process with an exit code. */
  exit(code = 0) {
    this.emit('exit', code);
    this.emit('close', code);
  }
}

/**
 * Replace child_process.spawn with a factory that records every invocation.
 * @param {import('vitest').VitestUtils} vi
 * @param {(child: FakeChildProcess) => void} [onSpawn] runs synchronously after each spawn
 */
function fakeSpawn(vi, onSpawn) {
  const spawned = [];
  vi.spyOn(childProcess, 'spawn').mockImplementation((command, args, options) => {
    const child = new FakeChildProcess(command, args, options);
    spawned.push(child);
    if (onSpawn) onSpawn(child);
    return child;
  });
  return spawned;
}

/**
 * Replace child_process.spawn with one that immediately completes, emitting the
 * given stdout and exit code. Covers the "run a PowerShell one-liner" case.
 */
function fakeSpawnResult(vi, { stdout = '', stderr = '', code = 0, delayMs = 0 } = {}) {
  return fakeSpawn(vi, child => {
    setTimeout(() => {
      if (stdout) child.emitStdout(stdout);
      if (stderr) child.emitStderr(stderr);
      child.exit(code);
    }, delayMs);
  });
}

module.exports = { FakeChildProcess, fakeSpawn, fakeSpawnResult };
