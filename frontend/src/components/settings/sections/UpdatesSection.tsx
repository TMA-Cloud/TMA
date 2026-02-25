import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsItem } from '../components/SettingsItem';
import type { VersionInfo } from '../../../utils/api';
import { getElectronAppVersion, isElectron } from '../../../utils/electronDesktop';

interface UpdatesSectionProps {
  versionStatusText: (key: keyof VersionInfo) => string;
  versionDescription: (key: keyof VersionInfo) => string;
  checkingVersions: boolean;
  versionError: string | null;
  onCheckVersions: () => void;
  latestElectronVersion: string | null;
}

export const UpdatesSection: React.FC<UpdatesSectionProps> = ({
  versionStatusText,
  versionDescription,
  checkingVersions,
  versionError,
  onCheckVersions,
  latestElectronVersion,
}) => {
  const runningInDesktopApp = isElectron();
  const [desktopAppVersion, setDesktopAppVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!runningInDesktopApp) return;
    void (async () => {
      const v = await getElectronAppVersion();
      setDesktopAppVersion(v);
    })();
  }, [runningInDesktopApp]);

  return (
    <SettingsSection title="Updates" icon={RefreshCw} description="Check whether this deployment is up to date.">
      <SettingsItem
        label="Frontend"
        value={versionStatusText('frontend')}
        description={versionDescription('frontend')}
      />
      <SettingsItem label="Backend" value={versionStatusText('backend')} description={versionDescription('backend')} />
      {runningInDesktopApp && (
        <SettingsItem
          label="Desktop app"
          value={
            desktopAppVersion && latestElectronVersion
              ? desktopAppVersion === latestElectronVersion
                ? `☑️ Up to date (v${desktopAppVersion})`
                : `⚠️ Outdated (v${desktopAppVersion})`
              : desktopAppVersion
                ? `Current v${desktopAppVersion}`
                : 'Unknown'
          }
          description={
            !desktopAppVersion
              ? 'Unable to read desktop app version from the Electron client.'
              : checkingVersions && !latestElectronVersion
                ? 'Checking update feed...'
                : latestElectronVersion
                  ? `Latest available: v${latestElectronVersion}`
                  : 'Version reported by the installed Electron desktop client.'
          }
        />
      )}
      <SettingsItem
        label="Check for Updates"
        value=""
        action={checkingVersions ? 'Checking...' : 'Check now'}
        onAction={onCheckVersions}
        actionDisabled={checkingVersions}
        description={versionError ?? 'Fetches latest version tags from tma-cloud.github.io'}
      />
    </SettingsSection>
  );
};
