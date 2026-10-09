import { useCallback, useState } from 'react';
import { useAbortableLoader } from '../../../hooks/useAbortableLoader';
import { useAsyncAction } from '../../../hooks/useAsyncAction';
import { getCloudDriveConfig, updateCloudDriveConfig } from '../../../utils/api';
import { refreshElectronCloudDriveMode } from '../../../utils/electronDesktop';

/**
 * The Cloud Drive save-only switch the first user sets for every desktop app.
 * Other drives pick a change up on their next check; this device's drive
 * applies it at once.
 */
export function useCloudDrivePolicy(enabled: boolean) {
  const [saveOnly, setSaveOnly] = useState<boolean | null>(null);

  const { loading } = useAbortableLoader({
    fetcher: getCloudDriveConfig,
    onSuccess: config => setSaveOnly(config.saveOnly),
    errorMessage: 'Failed to load the Cloud Drive mode',
    enabled,
  });

  const save = useCallback(async (next: boolean) => {
    const saved = await updateCloudDriveConfig(next);
    setSaveOnly(saved.saveOnly);
    void refreshElectronCloudDriveMode();
    return saved.saveOnly;
  }, []);
  const { run, busy: saving } = useAsyncAction(save, { errorMessage: 'Failed to save the Cloud Drive mode' });

  const toggle = useCallback(() => {
    if (saveOnly !== null) void run(!saveOnly);
  }, [run, saveOnly]);

  return { saveOnly, loading, saving, toggle };
}
