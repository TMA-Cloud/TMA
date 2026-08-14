import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from './useToast';
import { isAuthError } from '../utils/errorUtils';

interface UseAbortableLoaderOptions<T> {
  fetcher: (signal: AbortSignal) => Promise<T>;
  onSuccess: (data: T) => void;
  errorMessage: string;
  enabled: boolean;
  resetOnDisable?: unknown;
}

/**
 * Loads remote config with cancellation on unmount / re-trigger / disabled.
 * Silences AbortError and auth errors. Surfaces other errors via toast.
 */
export function useAbortableLoader<T>({
  fetcher,
  onSuccess,
  errorMessage,
  enabled,
  resetOnDisable,
}: UseAbortableLoaderOptions<T>) {
  const { showToast } = useToast();
  const [loading, setLoading] = useState(true);
  const abortControllerRef = useRef<AbortController | null>(null);

  const fetcherRef = useRef(fetcher);
  const onSuccessRef = useRef(onSuccess);
  const errorMessageRef = useRef(errorMessage);
  // `showToast` belongs with the rest of these. Depending on its identity made
  // `load` change whenever the toast provider re-rendered, so the effect below
  // refetched on every toast and overwrote the form the user was typing into
  // with whatever the server last said.
  const showToastRef = useRef(showToast);
  useEffect(() => {
    fetcherRef.current = fetcher;
    onSuccessRef.current = onSuccess;
    errorMessageRef.current = errorMessage;
    showToastRef.current = showToast;
  });

  const load = useCallback(async () => {
    if (abortControllerRef.current) abortControllerRef.current.abort();
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      setLoading(true);
      if (abortController.signal.aborted) return;
      const data = await fetcherRef.current(abortController.signal);
      if (abortController.signal.aborted) return;
      onSuccessRef.current(data);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      if (isAuthError(error)) return;
      showToastRef.current(errorMessageRef.current, 'error');
    } finally {
      if (!abortController.signal.aborted && abortControllerRef.current === abortController) {
        setLoading(false);
        abortControllerRef.current = null;
      }
    }
    // Everything it reads goes through a ref, so `load` is stable for the life
    // of the hook and the effect that runs it fires only when `enabled` moves.
  }, []);

  useEffect(() => {
    if (!enabled && abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, [enabled, resetOnDisable]);

  useEffect(() => {
    if (enabled) Promise.resolve().then(load);
  }, [enabled, load]);

  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    };
  }, []);

  return { loading, setLoading, reload: load };
}
