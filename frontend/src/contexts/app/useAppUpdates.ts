import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchLatestVersions, getCurrentVersions, sendClientHeartbeat } from '../../utils/api';
import {
  downloadAndInstallElectronUpdate,
  getElectronAppVersion,
  isElectron,
  subscribeToUpdateDownloadProgress,
} from '../../utils/electronDesktop';

interface AppUpdatesDeps {
  /** Signed-in user id; the desktop heartbeat only runs while someone is signed in. */
  userId: string | undefined;
}

type UpdatesAvailable = { frontend?: string; backend?: string; electron?: string } | null;

/** Version awareness: update banner, desktop heartbeat, and Electron auto-update. */
export function useAppUpdates({ userId }: AppUpdatesDeps) {
  const [updatesAvailable, setUpdatesAvailable] = useState<UpdatesAvailable>(null);
  const [hasCheckedUpdates, setHasCheckedUpdates] = useState(false);
  const [electronAutoUpdateState, setElectronAutoUpdateState] = useState<{
    status: 'idle' | 'downloading' | 'installing' | 'done' | 'error';
    progress: number | null;
    error?: string;
  }>({ status: 'idle', progress: null });

  const electronAutoUpdateTriggeredRef = useRef(false);

  // Desktop heartbeat

  useEffect(() => {
    if (!isElectron() || !userId) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const beat = async () => {
      try {
        const v = await getElectronAppVersion();
        await sendClientHeartbeat(v || 'unknown', window.electronAPI?.platform);
      } catch {
        // heartbeat is best-effort
      }
    };

    void beat();
    timer = setInterval(beat, 2 * 60 * 1000);

    return () => {
      if (timer) clearInterval(timer);
    };
  }, [userId]);

  // One-time update check

  useEffect(() => {
    if (hasCheckedUpdates) return;

    /** Return true when `latest` is strictly newer than `current` using semver-like comparison. */
    const isNewerVersion = (current: string, latest: string): boolean => {
      const parse = (v: string) => v.replace(/^v/i, '').split('.').map(Number);
      const cur = parse(current);
      const lat = parse(latest);
      const len = Math.max(cur.length, lat.length);
      for (let i = 0; i < len; i++) {
        const c = cur[i] ?? 0;
        const l = lat[i] ?? 0;
        if (Number.isNaN(c) || Number.isNaN(l)) return current !== latest;
        if (l > c) return true;
        if (l < c) return false;
      }
      return false;
    };

    const checkForUpdatesOnce = async () => {
      try {
        const [current, latest] = await Promise.all([getCurrentVersions(), fetchLatestVersions()]);
        const outdated: { frontend?: string; backend?: string; electron?: string } = {};

        if (current.frontend && latest.frontend && isNewerVersion(current.frontend, latest.frontend)) {
          outdated.frontend = latest.frontend;
        }
        if (current.backend && latest.backend && isNewerVersion(current.backend, latest.backend)) {
          outdated.backend = latest.backend;
        }
        if (isElectron() && latest.electron) {
          try {
            const v = await getElectronAppVersion();
            if (v && isNewerVersion(v, latest.electron)) outdated.electron = latest.electron;
          } catch {
            // Ignore Electron version errors for the banner
          }
        }

        setUpdatesAvailable(Object.keys(outdated).length > 0 ? outdated : null);
      } catch {
        setUpdatesAvailable(null);
      } finally {
        setHasCheckedUpdates(true);
      }
    };
    void checkForUpdatesOnce();
  }, [hasCheckedUpdates]);

  const runElectronAutoUpdate = useCallback(async (version: string) => {
    if (!isElectron() || !version) return;
    if (electronAutoUpdateTriggeredRef.current) return;

    electronAutoUpdateTriggeredRef.current = true;
    setElectronAutoUpdateState({ status: 'downloading', progress: 0 });

    const unsubscribe = subscribeToUpdateDownloadProgress(percent => {
      setElectronAutoUpdateState(prev => ({ ...prev, progress: percent }));
    });

    try {
      const result = await downloadAndInstallElectronUpdate(version);
      if (result.ok) {
        setElectronAutoUpdateState({ status: 'installing', progress: 100 });
      } else {
        setElectronAutoUpdateState({ status: 'error', progress: null, error: result.error });
        electronAutoUpdateTriggeredRef.current = false;
      }
    } catch {
      setElectronAutoUpdateState({ status: 'error', progress: null, error: 'Auto-update failed unexpectedly' });
      electronAutoUpdateTriggeredRef.current = false;
    } finally {
      unsubscribe();
    }
  }, []);

  const retryElectronUpdate = useCallback(async () => {
    if (!updatesAvailable?.electron) return;
    await runElectronAutoUpdate(updatesAvailable.electron);
  }, [updatesAvailable, runElectronAutoUpdate]);

  // Auto-download & auto-install electron update once detected
  useEffect(() => {
    if (!isElectron() || !updatesAvailable?.electron) return;
    if (electronAutoUpdateTriggeredRef.current) return;

    const autoUpdateDelay = setTimeout(async () => {
      const version = updatesAvailable?.electron;
      if (!version) return;
      await runElectronAutoUpdate(version);
    }, 3000);

    return () => clearTimeout(autoUpdateDelay);
  }, [updatesAvailable?.electron, runElectronAutoUpdate]);

  return {
    updatesAvailable,
    electronAutoUpdateState,
    retryElectronUpdate,
  };
}
