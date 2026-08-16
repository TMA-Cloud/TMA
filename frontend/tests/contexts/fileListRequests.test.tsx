import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

/**
 * Listing a folder used to be triggered from two places at once — the
 * navigation effect and the search effect's "box is empty" branch. Both fired
 * on the same renders, so every mount, folder change and sort change put two
 * identical GETs on the wire and immediately aborted the first. It looked
 * harmless in the UI and showed up only as a cancelled row in the network tab,
 * with the server doing the work twice.
 *
 * These count requests rather than inspect effects: the duplicate can come back
 * from any caller, and the wire is the only place it is visible.
 */

/** Every /api/files listing URL that reached the network, in order. */
let listCalls: string[] = [];

class SilentEventSource {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  close() {}
}

function isListRequest(url: string): boolean {
  const { pathname } = new URL(url, 'http://localhost');
  return pathname.startsWith('/api/files') && pathname !== '/api/files/events';
}

beforeEach(() => {
  listCalls = [];
  vi.stubGlobal('EventSource', SilentEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (isListRequest(url)) listCalls.push(url);
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    })
  );
});

/** Hands the context out so a test can drive it the way the UI would. */
function harness() {
  let api: ReturnType<typeof useApp> | null = null;
  const Consumer: React.FC = () => {
    api = useApp();
    return null;
  };
  const tree = (
    <ToastProvider>
      <AuthProvider>
        <AppProvider>
          <Consumer />
        </AppProvider>
      </AuthProvider>
    </ToastProvider>
  );
  return { tree, get: () => api! };
}

describe('file list requests', () => {
  it('lists the folder once on mount', async () => {
    const { tree } = harness();
    render(tree);

    await waitFor(() => expect(listCalls.length).toBeGreaterThan(0));
    // Settle anything queued behind the first response before counting.
    await act(async () => {
      await Promise.resolve();
    });

    expect(listCalls, `mount issued ${listCalls.length} listings:\n${listCalls.join('\n')}`).toHaveLength(1);
  });

  it('lists once per sort change', async () => {
    const { tree, get } = harness();
    render(tree);
    await waitFor(() => expect(listCalls.length).toBe(1));

    listCalls = [];
    await act(async () => {
      get().setSortBy('size');
    });
    await waitFor(() => expect(listCalls.length).toBeGreaterThan(0));
    await act(async () => {
      await Promise.resolve();
    });

    expect(listCalls, `one sort change issued ${listCalls.length} listings:\n${listCalls.join('\n')}`).toHaveLength(1);
    expect(listCalls[0]).toContain('sortBy=size');
  });

  it('lists once when the search box is cleared', async () => {
    const { tree, get } = harness();
    render(tree);
    await waitFor(() => expect(listCalls.length).toBe(1));

    await act(async () => {
      get().setSearchQuery('report');
    });

    listCalls = [];
    await act(async () => {
      get().setSearchQuery('');
    });
    await waitFor(() => expect(listCalls.length).toBeGreaterThan(0));
    await act(async () => {
      await Promise.resolve();
    });

    expect(listCalls, `clearing search issued ${listCalls.length} listings:\n${listCalls.join('\n')}`).toHaveLength(1);
  });
});
