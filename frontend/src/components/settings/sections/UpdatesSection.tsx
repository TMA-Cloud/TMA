import React, { useEffect, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsItem } from '../components/SettingsItem';
import { SettingsGroup } from '../components/SettingsGroup';
import { SettingsNote } from '../components/SettingsNote';
import { StatusChip, type StatusTone } from '../components/StatusChip';
import type { VersionInfo } from '../../../utils/api';
import type { VersionStatus } from '../hooks/useVersions';
import { getElectronAppVersion, isElectron } from '../../../utils/electronDesktop';

interface UpdatesSectionProps {
  versionStatus: (key: keyof VersionInfo) => VersionStatus;
  versionDescription: (key: keyof VersionInfo) => string;
  checkingVersions: boolean;
  versionError: string | null;
  onCheckVersions: () => void;
  latestElectronVersion: string | null;
}

const STATE_CHIP: Record<VersionStatus['state'], { tone: StatusTone; label: string }> = {
  loading: { tone: 'neutral', label: 'Loading...' },
  unchecked: { tone: 'unknown', label: 'Not checked' },
  upToDate: { tone: 'success', label: 'Up to date' },
  outdated: { tone: 'warning', label: 'Update available' },
};

/**
 * One component's version, with its state shown as a chip beside it.
 *
 * State and version used to share a single string ("⚠️ Outdated (current
 * v3.1.2, latest v3.2.0)"), which buries the two version numbers a reader
 * actually wants to compare. They now sit next to each other.
 */
const VersionRow: React.FC<{ label: string; status: VersionStatus; description: string }> = ({
  label,
  status,
  description,
}) => {
  const chip = STATE_CHIP[status.state];

  return (
    <div className="stagger-item flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between rounded-xl bg-white/60 dark:bg-gray-900/50 border border-slate-200/50 dark:border-slate-700/30 px-4 py-3 hover:border-blue-500/30 dark:hover:border-blue-500/30 transition-all duration-200">
      <div className="min-w-0">
        <p className="type-callout font-medium text-gray-900 dark:text-gray-100">{label}</p>
        <p className="type-caption text-gray-500 dark:text-gray-400 mt-0.5 max-w-prose">{description}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {status.current && (
          <span className="type-footnote font-semibold text-gray-700 dark:text-gray-200 tabular-nums">
            v{status.current}
          </span>
        )}
        <StatusChip tone={chip.tone}>{chip.label}</StatusChip>
      </div>
    </div>
  );
};

export const UpdatesSection: React.FC<UpdatesSectionProps> = ({
  versionStatus,
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

  const desktopStatus: VersionStatus = (() => {
    if (!desktopAppVersion) return { state: 'loading', current: null, latest: null };
    if (!latestElectronVersion) return { state: 'unchecked', current: desktopAppVersion, latest: null };
    return {
      state: desktopAppVersion === latestElectronVersion ? 'upToDate' : 'outdated',
      current: desktopAppVersion,
      latest: latestElectronVersion,
    };
  })();

  const desktopDescription = (() => {
    if (!desktopAppVersion) return 'Unable to read the desktop app version from the Electron client';
    if (checkingVersions && !latestElectronVersion) return 'Checking update feed...';
    if (latestElectronVersion) return `Latest available: v${latestElectronVersion}`;
    return 'Version reported by the installed Electron desktop client';
  })();

  return (
    <SettingsSection title="Updates" icon={RefreshCw} description="Version status for this deployment">
      <div className="space-y-8">
        {versionError && <SettingsNote tone="warning">{versionError}</SettingsNote>}

        <SettingsGroup title="Components" description="What each part of this deployment is currently running.">
          <VersionRow
            label="Frontend"
            status={versionStatus('frontend')}
            description={versionDescription('frontend')}
          />
          <VersionRow label="Backend" status={versionStatus('backend')} description={versionDescription('backend')} />
          {runningInDesktopApp && (
            <VersionRow label="Desktop app" status={desktopStatus} description={desktopDescription} />
          )}
        </SettingsGroup>

        <SettingsGroup
          title="Update check"
          description="Nothing is installed automatically — this only compares versions against the release feed."
        >
          <SettingsItem
            label="Check for updates"
            value=""
            action={checkingVersions ? 'Checking...' : 'Check now'}
            actionIcon={Search}
            onAction={onCheckVersions}
            actionDisabled={checkingVersions}
            description="Fetches the latest release tags from tma-cloud.github.io"
          />
        </SettingsGroup>
      </div>
    </SettingsSection>
  );
};
