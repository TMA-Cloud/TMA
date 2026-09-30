import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createStore, useStore } from '../../src/utils/store';

describe('createStore', () => {
  it('applies updaters and notifies subscribers', () => {
    const store = createStore(1);
    const listener = vi.fn();
    store.subscribe(listener);
    store.set(n => n + 1);
    expect(store.get()).toBe(2);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('skips notifying when the value is unchanged', () => {
    const list = [1];
    const store = createStore(list);
    const listener = vi.fn();
    store.subscribe(listener);
    store.set(prev => prev);
    expect(listener).not.toHaveBeenCalled();
  });

  it('re-renders a selector subscriber only when its result changes', () => {
    const store = createStore([{ busy: false }, { busy: false }]);
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useStore(store, items => items.some(item => item.busy));
    });
    const before = renders;
    act(() => store.set(items => [...items, { busy: false }]));
    expect(renders).toBe(before);
    act(() => store.set(items => [...items, { busy: true }]));
    expect(result.current).toBe(true);
    expect(renders).toBe(before + 1);
  });
});
