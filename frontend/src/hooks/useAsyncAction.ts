import { useCallback, useState } from 'react';
import { useToast } from './useToast';
import { getErrorMessage } from '../utils/errorUtils';

interface UseAsyncActionOptions {
  /** Fallback message shown if the thrown error carries no readable message. */
  errorMessage?: string;
  /** Optional success message auto-shown as a toast after the action resolves. */
  successMessage?: string;
  /** Called after success, before successMessage is shown. */
  onSuccess?: () => void;
  /** Called after failure with the thrown error. If it returns false, the default error toast is suppressed. */
  onError?: (error: unknown) => boolean | void;
}

/**
 * Wraps an async action with a busy flag and standard error-toast handling.
 * Replaces the repeated `try { setSaving(true); await ...; } catch (e) { showToast(getErrorMessage(e, ...), 'error'); } finally { setSaving(false); }` boilerplate.
 */
export function useAsyncAction<TArgs extends unknown[], TResult>(
  action: (...args: TArgs) => Promise<TResult>,
  options: UseAsyncActionOptions = {}
) {
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);
  const { errorMessage = 'Action failed', successMessage, onSuccess, onError } = options;

  const run = useCallback(
    async (...args: TArgs): Promise<TResult | undefined> => {
      setBusy(true);
      try {
        const result = await action(...args);
        onSuccess?.();
        if (successMessage) showToast(successMessage, 'success');
        return result;
      } catch (error) {
        const suppress = onError?.(error) === false;
        if (!suppress) {
          showToast(getErrorMessage(error, errorMessage), 'error');
        }
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [action, errorMessage, successMessage, onSuccess, onError, showToast]
  );

  return { run, busy };
}
