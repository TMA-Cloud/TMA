import { useCallback, useState } from 'react';
import { useAbortableLoader } from '../../../hooks/useAbortableLoader';
import { useAsyncAction } from '../../../hooks/useAsyncAction';
import {
  deleteGoogleAuthConfig,
  getGoogleAuthConfig,
  updateGoogleAuthConfig,
  type GoogleAuthSettings,
} from '../../../utils/api';

export interface GoogleSignInInput {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * Loads the saved Google client and saves or removes it. Every write carries
 * the version it was based on, so a save from a stale tab is refused rather
 * than overwriting a newer one.
 */
export function useGoogleSignInSettings(enabled: boolean) {
  const [settings, setSettings] = useState<GoogleAuthSettings | null>(null);

  const { loading } = useAbortableLoader({
    fetcher: getGoogleAuthConfig,
    onSuccess: setSettings,
    errorMessage: 'Failed to load Google sign-in settings',
    enabled,
  });

  const version = settings?.version ?? 0;

  const save = useCallback(
    async (input: GoogleSignInInput) => {
      setSettings(await updateGoogleAuthConfig({ ...input, expectedVersion: version }));
      return true;
    },
    [version]
  );
  const { run: saveSettings, busy: saving } = useAsyncAction(save, {
    errorMessage: 'Failed to save Google sign-in settings',
    successMessage: 'Google sign-in is on',
  });

  const remove = useCallback(async () => {
    setSettings(await deleteGoogleAuthConfig());
    return true;
  }, []);
  const { run: removeSettings, busy: removing } = useAsyncAction(remove, {
    errorMessage: 'Failed to turn off Google sign-in',
    successMessage: 'Google sign-in is off',
  });

  return { settings, loading, saveSettings, saving, removeSettings, removing };
}
