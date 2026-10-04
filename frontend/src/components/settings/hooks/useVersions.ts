import { useState, useCallback, useEffect } from 'react';
import { getCurrentVersions, fetchLatestVersions, type VersionInfo } from '../../../utils/api';

/** Where a component stands against the published release feed. */
type VersionState = 'loading' | 'unchecked' | 'upToDate' | 'outdated';

export interface VersionStatus {
  state: VersionState;
  current: string | null;
  latest: string | null;
}
import { getElectronAppVersion, isElectron } from '../../../utils/electronDesktop';
import { useToast } from '../../../hooks/useToast';

export function useVersions() {
  const { showToast } = useToast();
  const [currentVersions, setCurrentVersions] = useState<VersionInfo | null>(null);
  const [latestVersions, setLatestVersions] = useState<VersionInfo | null>(null);
  const [checkingVersions, setCheckingVersions] = useState(false);
  const [versionChecked, setVersionChecked] = useState(false);
  const [versionError, setVersionError] = useState<string | null>(null);

  const loadCurrentVersions = useCallback(async () => {
    try {
      const versions = await getCurrentVersions();
      setCurrentVersions(versions);
    } catch {
      // Error handled by error state
      setVersionError('Unable to load current version information');
    }
  }, []);

  const handleCheckVersions = useCallback(async () => {
    if (checkingVersions) return;

    try {
      setCheckingVersions(true);
      setVersionError(null);

      // Always fetch fresh current versions to detect backend redeployments
      const [current, latest] = await Promise.all([getCurrentVersions(), fetchLatestVersions()]);

      setCurrentVersions(current);
      setLatestVersions(latest);
      setVersionChecked(true);

      let allUpToDate = current.frontend === latest.frontend && current.backend === latest.backend;

      if (isElectron() && latest.electron) {
        try {
          const desktopVersion = await getElectronAppVersion();
          if (!desktopVersion || desktopVersion !== latest.electron) {
            allUpToDate = false;
          }
        } catch {
          allUpToDate = false;
        }
      }

      showToast(allUpToDate ? 'Everything is up to date' : 'Updates available', allUpToDate ? 'success' : 'info');
    } catch {
      // Error handled by error state and toast notification
      setVersionError('Unable to check for updates right now');
      showToast('Failed to check for updates', 'error');
    } finally {
      setCheckingVersions(false);
    }
  }, [checkingVersions, showToast]);

  /**
   * The comparison itself, rather than a sentence about it.
   *
   * This used to return strings with emoji baked in ("☑️ Up to date (v3.1.2)"),
   * which forced the view to parse meaning back out of prose. Returning the
   * state and the two versions lets the view decide how to show them.
   */
  const versionStatus = (key: keyof VersionInfo): VersionStatus => {
    const current = currentVersions?.[key] ?? null;
    if (!current) return { state: 'loading', current: null, latest: null };

    const latest = versionChecked ? (latestVersions?.[key] ?? null) : null;
    if (!latest) return { state: 'unchecked', current, latest: null };

    return { state: current === latest ? 'upToDate' : 'outdated', current, latest };
  };

  // The error itself is surfaced once as a banner, so it is not repeated here.
  const versionDescription = (key: keyof VersionInfo) => {
    if (checkingVersions && !versionChecked) return 'Checking update feed...';
    if (latestVersions?.[key]) return `Latest available: v${latestVersions[key]}`;
    return 'Version reported by this installation';
  };

  useEffect(() => {
    Promise.resolve().then(loadCurrentVersions);
  }, [loadCurrentVersions]);

  return {
    currentVersions,
    latestVersions,
    latestElectronVersion: latestVersions?.electron ?? null,
    checkingVersions,
    versionChecked,
    versionError,
    loadCurrentVersions,
    handleCheckVersions,
    versionStatus,
    versionDescription,
  };
}
