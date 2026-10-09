import { useCallback, useEffect, useState } from 'react';
import { getStorageStatus } from '../../utils/api';

/** Whether a storage bucket is connected, and whether this user may connect one. */
export function useStorageStatus() {
  // null until the first answer, so the setup banner never flashes on a configured instance.
  const [storageConfigured, setStorageConfigured] = useState<boolean | null>(null);
  const [canConfigureStorage, setCanConfigureStorage] = useState(false);

  const refreshStorageStatus = useCallback(async () => {
    try {
      const status = await getStorageStatus();
      setStorageConfigured(status.configured);
      setCanConfigureStorage(status.canConfigure);
    } catch {
      // Unknown is not the same as unconfigured; keep whatever was last known.
    }
  }, []);

  useEffect(() => {
    Promise.resolve().then(() => void refreshStorageStatus());
  }, [refreshStorageStatus]);

  return { storageConfigured, canConfigureStorage, refreshStorageStatus };
}
