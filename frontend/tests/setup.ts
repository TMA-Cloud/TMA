import '@testing-library/jest-dom/vitest';

import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

/**
 * Web Storage polyfill.
 *
 * Node 26 ships its own `localStorage` global that is disabled unless the
 * process is started with `--localstorage-file`, and it shadows the one jsdom
 * installs. Both end up `undefined`, which would break every code path in the
 * app that remembers auth state or the desktop client id. Install a plain
 * in-memory implementation instead.
 */
class MemoryStorage implements Storage {
  private store = new Map<string, string>();

  get length(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }

  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }

  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

function installStorage(name: 'localStorage' | 'sessionStorage') {
  const storage = new MemoryStorage();
  const descriptor = { value: storage, writable: true, configurable: true };
  Object.defineProperty(globalThis, name, descriptor);
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, name, descriptor);
  }
  return storage;
}

let localStore = installStorage('localStorage');
let sessionStore = installStorage('sessionStorage');

beforeEach(() => {
  // jsdom does not implement these, and several components read them on mount.
  if (!window.matchMedia) {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  }

  if (!window.URL.createObjectURL) {
    window.URL.createObjectURL = vi.fn(() => 'blob:mock-url');
    window.URL.revokeObjectURL = vi.fn();
  }

  // A test may have replaced storage with a spy; reinstall a clean one.
  localStore = installStorage('localStorage');
  sessionStore = installStorage('sessionStorage');
  localStore.clear();
  sessionStore.clear();
});

afterEach(() => {
  cleanup();
});
