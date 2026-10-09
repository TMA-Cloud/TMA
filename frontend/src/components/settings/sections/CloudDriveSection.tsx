import React, { useEffect, useState } from 'react';
import { FolderSync } from 'lucide-react';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsItem } from '../components/SettingsItem';
import { SettingsGroup } from '../components/SettingsGroup';
import { SettingsNote } from '../components/SettingsNote';
import {
  hasElectronCloudDrive,
  refreshElectronCloudDriveMode,
  type CloudDriveMode,
} from '../../../utils/electronDesktop';

/**
 * Desktop-only view of the TMA Cloud drive (WinFsp mount): where it is mounted
 * and the access mode the first user set for every desktop app.
 *
 * Renders nothing outside the desktop app.
 */
export const CloudDriveSection: React.FC = () => {
  const available = hasElectronCloudDrive();

  const [mode, setMode] = useState<CloudDriveMode | null>(null);
  const [mountPoint, setMountPoint] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!available) return;
    let cancelled = false;
    void (async () => {
      try {
        const [current, status] = await Promise.all([
          refreshElectronCloudDriveMode(),
          window.electronAPI?.cloudDrive?.status?.(),
        ]);
        if (cancelled) return;
        setMode(current);
        setMountPoint(status?.mountPoint ?? null);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [available]);

  if (!available) return null;

  const modeLabel = !loaded ? 'Checking...' : mode === 'full' ? 'Full access' : 'Save-only';

  return (
    <SettingsSection
      title="Cloud Drive"
      icon={FolderSync}
      description="Save to TMA Cloud from any app's Save As dialog"
    >
      <div className="space-y-8">
        <SettingsGroup title="Mount" description="Where the drive appears on this computer.">
          <SettingsItem
            label="Mount point"
            value={mountPoint ?? (loaded ? 'Not mounted' : 'Checking...')}
            description="The drive letter or path other apps will see"
          />
        </SettingsGroup>

        <SettingsGroup title="Access mode" description="What other apps may do with files on the drive.">
          <SettingsItem
            label="Mode"
            value={modeLabel}
            description={
              mode === 'full'
                ? 'Other apps can open and copy files from the drive'
                : 'Folders stay browsable; opening and copying are blocked'
            }
          />
          <SettingsNote>Set by the admin for every desktop app.</SettingsNote>
        </SettingsGroup>
      </div>
    </SettingsSection>
  );
};
