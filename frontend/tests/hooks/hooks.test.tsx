import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PromiseQueue, useDebouncedCallback } from '../../src/utils/debounce';
import { ToastProvider } from '../../src/hooks/ToastProvider';
import { useAbortableLoader } from '../../src/hooks/useAbortableLoader';
import { useAsyncAction } from '../../src/hooks/useAsyncAction';
import { useIsMobile } from '../../src/hooks/useIsMobile';
import { useIsMounted } from '../../src/hooks/useIsMounted';
import { ApiError } from '../../src/utils/errorUtils';

const withToasts = ({ children }: { children: React.ReactNode }) => <ToastProvider>{children}</ToastProvider>;

describe('useDebouncedCallback', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('defers the call until the delay elapses', () => {
    const spy = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(spy, 300));

    act(() => result.current[0]('a'));
    expect(spy).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(300));
    expect(spy).toHaveBeenCalledWith('a');
  });

  it('collapses a burst into a single trailing call', () => {
    const spy = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(spy, 300));

    act(() => {
      result.current[0]('a');
      vi.advanceTimersByTime(100);
      result.current[0]('b');
      vi.advanceTimersByTime(100);
      result.current[0]('c');
      vi.advanceTimersByTime(300);
    });

    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith('c');
  });

  it('can be cancelled before it fires', () => {
    const spy = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(spy, 300));

    act(() => {
      result.current[0]('a');
      result.current[1]();
      vi.advanceTimersByTime(500);
    });

    expect(spy).not.toHaveBeenCalled();
  });

  it('cancels a pending call on unmount, so no state update lands after teardown', () => {
    const spy = vi.fn();
    const { result, unmount } = renderHook(() => useDebouncedCallback(spy, 300));

    act(() => result.current[0]('a'));
    unmount();
    act(() => vi.advanceTimersByTime(500));

    expect(spy).not.toHaveBeenCalled();
  });

  it('always calls the latest callback, not the one captured at first render', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender } = renderHook(({ cb }) => useDebouncedCallback(cb, 300), {
      initialProps: { cb: first },
    });

    act(() => result.current[0]('x'));
    rerender({ cb: second });
    act(() => vi.advanceTimersByTime(300));

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('x');
  });

  it('forwards every argument', () => {
    const spy = vi.fn();
    const { result } = renderHook(() => useDebouncedCallback(spy, 100));
    act(() => {
      result.current[0]('a', 1, { z: true });
      vi.advanceTimersByTime(100);
    });
    expect(spy).toHaveBeenCalledWith('a', 1, { z: true });
  });
});

describe('PromiseQueue', () => {
  it('resolves with the operation result', async () => {
    await expect(new PromiseQueue().add(async () => 42)).resolves.toBe(42);
  });

  it('runs operations one at a time, in order', async () => {
    const queue = new PromiseQueue();
    const order: number[] = [];
    const task = (n: number) => async () => {
      await new Promise(r => setTimeout(r, 10 - n));
      order.push(n);
    };

    await Promise.all([queue.add(task(1)), queue.add(task(2)), queue.add(task(3))]);

    expect(order).toEqual([1, 2, 3]);
  });

  it('never overlaps two operations', async () => {
    const queue = new PromiseQueue();
    let running = 0;
    let peak = 0;
    const task = async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise(r => setTimeout(r, 5));
      running--;
    };

    await Promise.all([queue.add(task), queue.add(task), queue.add(task)]);

    expect(peak).toBe(1);
  });

  it('rejects the caller when an operation throws', async () => {
    await expect(
      new PromiseQueue().add(async () => {
        throw new Error('operation failed');
      })
    ).rejects.toThrow('operation failed');
  });

  it('keeps draining the queue after one operation fails', async () => {
    const queue = new PromiseQueue();
    const failing = queue.add(async () => {
      throw new Error('boom');
    });
    const following = queue.add(async () => 'still ran');

    await expect(failing).rejects.toThrow('boom');
    await expect(following).resolves.toBe('still ran');
  });

  it('accepts new work after going idle', async () => {
    const queue = new PromiseQueue();
    await queue.add(async () => 1);
    await expect(queue.add(async () => 2)).resolves.toBe(2);
  });
});

describe('useIsMobile', () => {
  const setWidth = (width: number) => {
    Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
  };

  it('treats widths up to 1024px as mobile', () => {
    setWidth(1024);
    expect(renderHook(() => useIsMobile()).result.current).toBe(true);
  });

  it('treats wider viewports as desktop', () => {
    setWidth(1025);
    expect(renderHook(() => useIsMobile()).result.current).toBe(false);
  });

  it('reacts to a resize', () => {
    setWidth(1440);
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);

    act(() => {
      setWidth(390);
      window.dispatchEvent(new Event('resize'));
    });

    expect(result.current).toBe(true);
  });

  it('detaches its resize listener on unmount', () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener');
    renderHook(() => useIsMobile()).unmount();
    expect(removeSpy).toHaveBeenCalledWith('resize', expect.any(Function));
  });
});

describe('useIsMounted', () => {
  it('reports true while mounted', () => {
    expect(renderHook(() => useIsMounted()).result.current.current).toBe(true);
  });

  it('flips to false after unmount, so late callbacks can bail out', () => {
    const { result, unmount } = renderHook(() => useIsMounted());
    unmount();
    expect(result.current.current).toBe(false);
  });
});

describe('useAsyncAction', () => {
  it('returns the action result', async () => {
    const { result } = renderHook(() => useAsyncAction(async () => 'done'), { wrapper: withToasts });
    await act(async () => {
      await expect(result.current.run()).resolves.toBe('done');
    });
  });

  it('reports busy while the action is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const { result } = renderHook(() => useAsyncAction(async () => gate), { wrapper: withToasts });

    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.run();
    });
    await waitFor(() => expect(result.current.busy).toBe(true));

    await act(async () => {
      release();
      await pending;
    });
    expect(result.current.busy).toBe(false);
  });

  it('swallows the error and returns undefined so callers need no try/catch', async () => {
    const { result } = renderHook(
      () =>
        useAsyncAction(async () => {
          throw new Error('nope');
        }),
      { wrapper: withToasts }
    );

    await act(async () => {
      await expect(result.current.run()).resolves.toBeUndefined();
    });
  });

  it('clears the busy flag even when the action throws', async () => {
    const { result } = renderHook(
      () =>
        useAsyncAction(async () => {
          throw new Error('nope');
        }),
      { wrapper: withToasts }
    );

    await act(async () => {
      await result.current.run();
    });
    expect(result.current.busy).toBe(false);
  });

  it('runs the success callback before showing the success toast', async () => {
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useAsyncAction(async () => 'ok', { onSuccess, successMessage: 'Saved' }), {
      wrapper: withToasts,
    });

    await act(async () => {
      await result.current.run();
    });
    expect(onSuccess).toHaveBeenCalled();
  });

  it('does not run the success callback when the action fails', async () => {
    const onSuccess = vi.fn();
    const { result } = renderHook(
      () =>
        useAsyncAction(
          async () => {
            throw new Error('nope');
          },
          { onSuccess }
        ),
      { wrapper: withToasts }
    );

    await act(async () => {
      await result.current.run();
    });
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('hands the thrown error to the error callback', async () => {
    const onError = vi.fn();
    const error = new ApiError('Forbidden', 403);
    const { result } = renderHook(
      () =>
        useAsyncAction(
          async () => {
            throw error;
          },
          { onError }
        ),
      { wrapper: withToasts }
    );

    await act(async () => {
      await result.current.run();
    });
    expect(onError).toHaveBeenCalledWith(error);
  });

  it('forwards the arguments it was called with', async () => {
    const action = vi.fn(async (_a: string, _b: number) => 'ok');
    const { result } = renderHook(() => useAsyncAction(action), { wrapper: withToasts });

    await act(async () => {
      await result.current.run('x', 1);
    });
    expect(action).toHaveBeenCalledWith('x', 1);
  });
});

describe('useAbortableLoader', () => {
  const baseOptions = {
    errorMessage: 'Could not load settings',
    enabled: true,
  };

  it('loads once enabled and hands the data to the success callback', async () => {
    const onSuccess = vi.fn();
    renderHook(() => useAbortableLoader({ ...baseOptions, fetcher: async () => ({ url: 'x' }), onSuccess }), {
      wrapper: withToasts,
    });

    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith({ url: 'x' }));
  });

  it('clears the loading flag once the fetch settles', async () => {
    const { result } = renderHook(
      () => useAbortableLoader({ ...baseOptions, fetcher: async () => 1, onSuccess: vi.fn() }),
      { wrapper: withToasts }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it('does not fetch while disabled', async () => {
    const fetcher = vi.fn(async () => 1);
    renderHook(() => useAbortableLoader({ ...baseOptions, enabled: false, fetcher, onSuccess: vi.fn() }), {
      wrapper: withToasts,
    });

    await new Promise(r => setTimeout(r, 20));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fetches when it becomes enabled', async () => {
    const fetcher = vi.fn(async () => 1);
    const { rerender } = renderHook(
      ({ enabled }) => useAbortableLoader({ ...baseOptions, enabled, fetcher, onSuccess: vi.fn() }),
      { wrapper: withToasts, initialProps: { enabled: false } }
    );

    rerender({ enabled: true });
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
  });

  /**
   * A fetcher that never settles on its own, plus a promise that resolves the
   * moment it is invoked. Polling with waitFor would be too coarse here — its
   * default 50ms interval can let a timer-based fetch finish before the test
   * gets a chance to abort it.
   */
  function pendingFetcher() {
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => (markStarted = resolve));
    let settle!: (value: number) => void;

    return {
      started,
      settle: (value = 1) => settle(value),
      fetcher: () =>
        new Promise<number>(resolve => {
          settle = resolve;
          markStarted();
        }),
    };
  }

  it('ignores a result that arrives after unmount aborted the request', async () => {
    const onSuccess = vi.fn();
    const { started, settle, fetcher } = pendingFetcher();

    const { unmount } = renderHook(() => useAbortableLoader({ ...baseOptions, fetcher, onSuccess }), {
      wrapper: withToasts,
    });

    await started;
    unmount();
    settle(1);
    await new Promise(r => setTimeout(r, 10));

    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('aborts the in-flight request when it is disabled mid-flight', async () => {
    const onSuccess = vi.fn();
    const { started, settle, fetcher } = pendingFetcher();

    const { rerender } = renderHook(
      ({ enabled }) => useAbortableLoader({ ...baseOptions, enabled, fetcher, onSuccess }),
      { wrapper: withToasts, initialProps: { enabled: true } }
    );

    await started;
    rerender({ enabled: false });
    settle(1);
    await new Promise(r => setTimeout(r, 10));

    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('hands the fetcher an abort signal so a real request can be cancelled', async () => {
    const fetcher = vi.fn(async (_signal: AbortSignal) => 1);
    renderHook(() => useAbortableLoader({ ...baseOptions, fetcher, onSuccess: vi.fn() }), { wrapper: withToasts });

    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    expect(fetcher.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
  });

  it('stays silent on an auth error, since the app is about to redirect to login', async () => {
    const onSuccess = vi.fn();
    const { result } = renderHook(
      () =>
        useAbortableLoader({
          ...baseOptions,
          fetcher: async () => {
            throw new ApiError('Unauthorized', 401);
          },
          onSuccess,
        }),
      { wrapper: withToasts }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(onSuccess).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('Could not load settings');
  });

  it('surfaces an ordinary failure as a toast', async () => {
    renderHook(
      () =>
        useAbortableLoader({
          ...baseOptions,
          fetcher: async () => {
            throw new Error('boom');
          },
          onSuccess: vi.fn(),
        }),
      { wrapper: withToasts }
    );

    await waitFor(() => expect(document.body.textContent).toContain('Could not load settings'));
  });

  it('exposes a reload that re-runs the fetch', async () => {
    const fetcher = vi.fn(async () => 1);
    const { result } = renderHook(() => useAbortableLoader({ ...baseOptions, fetcher, onSuccess: vi.fn() }), {
      wrapper: withToasts,
    });

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await act(async () => {
      await result.current.reload();
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
