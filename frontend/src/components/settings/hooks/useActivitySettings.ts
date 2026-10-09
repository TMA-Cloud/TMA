import { useCallback, useState } from 'react';
import { useAbortableLoader } from '../../../hooks/useAbortableLoader';
import { useAsyncAction } from '../../../hooks/useAsyncAction';
import {
  getActivityConfig,
  updateAccessTimeConfig,
  updateSessionTimeoutConfig,
  type ActivitySettings,
} from '../../../utils/api';

/**
 * Loads the session timeout and access-time settings once for both cards, and
 * saves each card's part. Every save answers with the full settings, so the
 * other card stays current too.
 */
export function useActivitySettings(enabled: boolean) {
  const [settings, setSettings] = useState<ActivitySettings | null>(null);

  const { loading } = useAbortableLoader({
    fetcher: getActivityConfig,
    onSuccess: setSettings,
    errorMessage: 'Failed to load session and access-time settings',
    enabled,
  });

  const saveSession = useCallback(async (idleDays: number) => {
    setSettings(await updateSessionTimeoutConfig(idleDays));
    return true;
  }, []);
  const { run: saveSessionTimeout, busy: savingSession } = useAsyncAction(saveSession, {
    errorMessage: 'Failed to save the session timeout',
    successMessage: 'Session timeout saved',
  });

  const saveAccess = useCallback(async (input: { enabled: boolean; windowMinutes: number; flushSeconds: number }) => {
    setSettings(await updateAccessTimeConfig(input));
    return true;
  }, []);
  const { run: saveAccessTime, busy: savingAccess } = useAsyncAction(saveAccess, {
    errorMessage: 'Failed to save access time settings',
    successMessage: 'Access time settings saved',
  });

  return { settings, loading, saveSessionTimeout, savingSession, saveAccessTime, savingAccess };
}
