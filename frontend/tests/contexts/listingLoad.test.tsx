import React from 'react';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/api', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/api')>('../../src/utils/api');
  return {
    ...actual,
    checkAuthSilently: vi.fn(async () => ({ status: 'unauthenticated' as const })),
    setAuthState: vi.fn(),
    hasAuthState: vi.fn(() => false),
    checkOnlyOfficeConfigured: vi.fn(async () => ({ configured: false, canConfigure: false })),
    getSignupStatus: vi.fn(async () => ({ enabled: false })),
    checkUploadStorage: vi.fn(async () => ({ ok: true })),
    getMaxUploadSizeConfig: vi.fn(async () => ({ maxUploadSize: 0 })),
    getCurrentVersions: vi.fn(async () => ({})),
    fetchLatestVersions: vi.fn(async () => ({})),
    sendClientHeartbeat: vi.fn(async () => undefined),
  };
});

import { AppProvider } from '../../src/contexts/AppProvider';
import { useApp } from '../../src/contexts/AppContext';
import { AuthProvider } from '../../src/contexts/AuthProvider';
import { ToastProvider } from '../../src/hooks/ToastProvider';
import { createListingCache, listingCacheKey } from '../../src/contexts/app/listingCache';
import { pickListView } from '../../src/components/fileManager/listView';
import { useDelayedFlag } from '../../src/hooks/useDelayedFlag';
import type { FileItem } from '../../src/contexts/AppContext';

/**
 * A folder used to read "This folder is empty" until its listing arrived, so
 * a large folder looked wiped for a second on every first visit. These pin
 * the loading states that replace it: pending, failed and cached.
 */

const file = (id: string): FileItem => ({ id, name: id, type: 'file', modified: new Date(0) });

describe('listing cache', () => {
  it('evicts the least recently used entry', () => {
    const cache = createListingCache(2);
    cache.set('a', { files: [file('1')], nextCursor: null });
    cache.set('b', { files: [file('2')], nextCursor: null });
    cache.get('a');
    cache.set('c', { files: [file('3')], nextCursor: null });

    expect(cache.get('a')).toBeDefined();
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBeDefined();
  });

  it('keeps only the named entry when told something changed', () => {
    const cache = createListingCache();
    cache.set('a', { files: [], nextCursor: null });
    cache.set('b', { files: [], nextCursor: null });
    cache.retainOnly('b');

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBeDefined();
  });

  it('keys each sort order separately', () => {
    expect(listingCacheKey('My Files/', 'name', 'asc')).not.toBe(listingCacheKey('My Files/', 'name', 'desc'));
  });
});

describe('pickListView', () => {
  const base = { showSkeleton: false, listingFailed: false, isListingPending: false, isSearching: false };

  it('never calls a folder empty while its listing is pending', () => {
    expect(pickListView({ ...base, isListingPending: true, hasFiles: false })).toBe('blank');
    expect(pickListView({ ...base, isListingPending: true, hasFiles: true })).toBe('rows');
    expect(pickListView({ ...base, isListingPending: true, showSkeleton: true, hasFiles: true })).toBe('skeleton');
  });

  it('shows an error rather than the previous folder when listing fails', () => {
    expect(pickListView({ ...base, listingFailed: true, hasFiles: true })).toBe('error');
  });

  it('shows the empty state only for a listed folder with nothing in it', () => {
    expect(pickListView({ ...base, hasFiles: false })).toBe('empty');
    expect(pickListView({ ...base, isSearching: true, hasFiles: false })).toBe('skeleton');
  });
});

describe('useDelayedFlag', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stays off for a load that finishes inside the delay', () => {
    const { result, rerender } = renderHook(({ on }) => useDelayedFlag(on, 200, 400), { initialProps: { on: true } });
    act(() => vi.advanceTimersByTime(150));
    rerender({ on: false });
    act(() => vi.advanceTimersByTime(500));

    expect(result.current).toBe(false);
  });

  it('holds the placeholder for the minimum time once shown', () => {
    const { result, rerender } = renderHook(({ on }) => useDelayedFlag(on, 200, 400), { initialProps: { on: true } });
    act(() => vi.advanceTimersByTime(200));
    expect(result.current).toBe(true);

    rerender({ on: false });
    act(() => vi.advanceTimersByTime(300));
    expect(result.current).toBe(true);
    act(() => vi.advanceTimersByTime(100));
    expect(result.current).toBe(false);
  });
});

class SilentEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  close() {}
}

type Reply = () => Response;
/** Each listing waits until the test answers it, so the in-between states can be observed. */
let pending: { url: string; resolve: (reply: Reply) => void }[] = [];

const listing =
  (ids: string[]): Reply =>
  () =>
    new Response(JSON.stringify(ids.map(id => ({ id, name: id, type: 'file', modified: new Date(0).toISOString() }))), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

beforeEach(() => {
  pending = [];
  vi.stubGlobal('EventSource', SilentEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const { pathname } = new URL(url, 'http://localhost');
      if (!pathname.startsWith('/api/files') || pathname === '/api/files/events') {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }
      return new Promise<Response>(resolve => pending.push({ url, resolve: reply => resolve(reply()) }));
    })
  );
});

function harness() {
  let api: ReturnType<typeof useApp> | null = null;
  const Consumer: React.FC = () => {
    api = useApp();
    return null;
  };
  render(
    <ToastProvider>
      <AuthProvider>
        <AppProvider>
          <Consumer />
        </AppProvider>
      </AuthProvider>
    </ToastProvider>
  );
  return () => api!;
}

async function answer(match: string, reply: Reply) {
  await waitFor(() => expect(pending.some(p => p.url.includes(match))).toBe(true));
  const index = pending.findIndex(p => p.url.includes(match));
  const [request] = pending.splice(index, 1);
  await act(async () => {
    request!.resolve(reply);
  });
}

describe('folder listing states', () => {
  it('is pending, not empty, until the first listing arrives', async () => {
    const get = harness();
    expect(get().isListingPending).toBe(true);

    await answer('/api/files', listing(['a']));
    await waitFor(() => expect(get().isListingPending).toBe(false));
    expect(get().files.map(f => f.id)).toEqual(['a']);
  });

  it('reports a failed listing so the view can offer a retry', async () => {
    const get = harness();
    await answer('/api/files', () => new Response('nope', { status: 500 }));

    await waitFor(() => expect(get().listingFailed).toBe(true));
    expect(get().isListingPending).toBe(false);
  });

  it('shows a folder seen before at once while it re-fetches', async () => {
    const get = harness();
    await answer('/api/files', listing(['root-file']));

    await act(async () => {
      get().openFolder({ id: 'folder-b', name: 'B', type: 'folder', modified: new Date(0) });
    });
    await answer('parentId=folder-b', listing(['b-file']));
    await waitFor(() => expect(get().files.map(f => f.id)).toEqual(['b-file']));

    await act(async () => {
      get().goBack();
    });
    // The re-fetch for My Files is still unanswered, yet its last copy is already up.
    await waitFor(() => expect(get().files.map(f => f.id)).toEqual(['root-file']));
    expect(get().isListingPending).toBe(false);
    expect(pending.length).toBe(1);

    await answer('/api/files', listing(['root-file', 'new-file']));
    await waitFor(() => expect(get().files.map(f => f.id)).toEqual(['root-file', 'new-file']));
  });
});
