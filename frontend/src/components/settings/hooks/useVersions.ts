import { useState, useCallback, useEffect } from 'react';
import { getCurrentVersions, fetchLatestVersions, type VersionInfo } from '../../../utils/api';
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

      showToast(
        allUpToDate ? 'All components are up to date' : 'Updates are available',
        allUpToDate ? 'success' : 'info'
      );
    } catch {
      // Error handled by error state and toast notification
      setVersionError('Unable to check for updates right now');
      showToast('Failed to check for updates', 'error');
    } finally {
      setCheckingVersions(false);
    }
  }, [checkingVersions, showToast]);

  const versionStatusText = (key: keyof VersionInfo) => {
    const current = currentVersions?.[key];
    if (!current) {
      return 'Loading current version...';
    }

    if (!versionChecked || !latestVersions) {
      return `Current v${current}`;
    }

    const latest = latestVersions[key];
    if (!latest) {
      return `Current v${current}`;
    }

    if (current === latest) {
      return `☑️ Up to date (v${current})`;
    }

    return `⚠️ Outdated (current v${current}, latest v${latest})`;
  };

  const versionDescription = (key: keyof VersionInfo) => {
    if (versionError) return versionError;
    if (checkingVersions && !versionChecked) return 'Checking update feed...';
    if (latestVersions?.[key]) return `Latest available: v${latestVersions[key]}`;
    return 'Version reported by this installation.';
  };

  useEffect(() => {
    loadCurrentVersions();
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
    versionStatusText,
    versionDescription,
  };
}
