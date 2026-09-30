import { useSyncExternalStore, type SetStateAction } from 'react';

/**
 * A value held outside React state, so writes re-render only the components
 * that subscribe to it — not the provider that owns it and everything below.
 */
export interface Store<T> {
  get: () => T;
  /** Same contract as a useState setter, including the Object.is bail-out. */
  set: (action: SetStateAction<T>) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: action => {
      const next = typeof action === 'function' ? (action as (prev: T) => T)(value) : action;
      if (Object.is(next, value)) return;
      value = next;
      listeners.forEach(listener => listener());
    },
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Subscribe to a store; with a selector, re-render only when its result changes. */
export function useStore<T>(store: Store<T>): T;
export function useStore<T, S>(store: Store<T>, selector: (value: T) => S): S;
export function useStore<T, S>(store: Store<T>, selector?: (value: T) => S): T | S {
  const read = () => (selector ? selector(store.get()) : store.get());
  return useSyncExternalStore(store.subscribe, read, read);
}
