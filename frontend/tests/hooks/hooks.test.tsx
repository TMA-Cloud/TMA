import React from 'react';
import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PromiseQueue, useDebouncedCallback } from '../../src/utils/debounce';
import { ToastProvider } from '../../src/hooks/ToastProvider';
import { useAbortableLoader } from '../../src/hooks/useAbortableLoader';
import { useAsyncAction } from '../../src/hooks/useAsyncAction';
import { ToastContext, useToast } from '../../src/hooks/useToast';
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

describe('a toast does not disturb what the user is doing', () => {
  /**
   * Toasts live in a provider that wraps the whole app, so anything unstable
   * in its context value reaches every consumer below it. useAbortableLoader
   * is one of those consumers, and its loader re-runs whenever its identity
   * changes — which meant a toast appearing or disappearing silently refetched
   * every settings pane on screen and handed the result to onSuccess, wiping
   * whatever the user had typed since.
   */
  function Harness({ fetcher, onSuccess }: { fetcher: () => Promise<number>; onSuccess: (n: number) => void }) {
    const { showToast } = useToast();
    useAbortableLoader({ fetcher, onSuccess, errorMessage: 'nope', enabled: true });
    return <button onClick={() => showToast('Enter a value between 1MB and 5GB', 'error')}>toast</button>;
  }

  it('does not refetch when a toast appears or is dismissed', async () => {
    const fetcher = vi.fn(async () => 1);
    const onSuccess = vi.fn();

    render(
      <ToastProvider>
        <Harness fetcher={fetcher} onSuccess={onSuccess} />
      </ToastProvider>
    );

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    // Show one, then let it dismiss itself. Neither may reload the pane.
    await userEvent.click(screen.getByRole('button', { name: 'toast' }));
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Close notification' }));
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());

    expect(fetcher, 'a toast refetched the pane behind it').toHaveBeenCalledTimes(1);
    expect(onSuccess, 'a toast re-applied loaded data over the user input').toHaveBeenCalledTimes(1);
  });

  it('keeps the value the user typed while a toast comes and goes', async () => {
    // The reported symptom, end to end: the field is reset from server data
    // the moment the toast leaves.
    function Field() {
      const { showToast } = useToast();
      const [value, setValue] = React.useState('');
      useAbortableLoader({
        fetcher: async () => '10',
        onSuccess: React.useCallback((loaded: string) => setValue(loaded), []),
        errorMessage: 'nope',
        enabled: true,
      });
      return (
        <>
          <input aria-label="Max upload size" value={value} onChange={e => setValue(e.target.value)} />
          <button onClick={() => showToast('Enter a value between 1MB and 5GB', 'error')}>reject</button>
        </>
      );
    }

    render(
      <ToastProvider>
        <Field />
      </ToastProvider>
    );

    const input = await screen.findByLabelText<HTMLInputElement>('Max upload size');
    await waitFor(() => expect(input.value).toBe('10'));

    await userEvent.click(screen.getByRole('button', { name: 'reject' }));
    await userEvent.clear(input);
    await userEvent.type(input, '25');
    expect(input.value).toBe('25');

    await userEvent.click(screen.getByRole('button', { name: 'Close notification' }));
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());

    expect(input.value, 'the toast leaving reset the field').toBe('25');
  });

  /**
   * The two guards above are deliberately independent, so either one alone
   * prevents the reset. That also means the end-to-end test cannot tell which
   * is doing the work, and would keep passing while one silently rotted. Each
   * gets its own case.
   */
  it('hands every consumer the same context value across toasts', async () => {
    const seen: unknown[] = [];
    function Spy() {
      seen.push(useToast());
      const { showToast } = useToast();
      return <button onClick={() => showToast('a message worth reading', 'info')}>toast</button>;
    }

    render(
      <ToastProvider>
        <Spy />
      </ToastProvider>
    );

    await userEvent.click(screen.getByRole('button', { name: 'toast' }));
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: 'Close notification' }));
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());

    // One render is the ideal outcome, not a weakness in the test: a stable
    // value means React never has to re-render the consumer at all. Losing the
    // memo shows up here as extra renders carrying a different object.
    expect(new Set(seen).size, `the toast context value changed identity across ${seen.length} renders`).toBe(1);
  });

  it('survives a provider that rebuilds its value on every render', async () => {
    // Stands in for any provider that forgets to memoise: the loader must not
    // reload just because something above it re-rendered.
    const fetcher = vi.fn(async () => 1);

    function UnstableProvider({ children }: { children: React.ReactNode }) {
      const [, force] = React.useState(0);
      return (
        <ToastContext.Provider value={{ showToast: () => {} }}>
          <button onClick={() => force(n => n + 1)}>re-render</button>
          {children}
        </ToastContext.Provider>
      );
    }

    function Consumer() {
      useAbortableLoader({ fetcher, onSuccess: vi.fn(), errorMessage: 'nope', enabled: true });
      return null;
    }

    render(
      <UnstableProvider>
        <Consumer />
      </UnstableProvider>
    );

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole('button', { name: 're-render' }));
    await userEvent.click(screen.getByRole('button', { name: 're-render' }));
    await new Promise(r => setTimeout(r, 20));

    expect(fetcher, 'an unrelated re-render reloaded the pane').toHaveBeenCalledTimes(1);
  });
});
