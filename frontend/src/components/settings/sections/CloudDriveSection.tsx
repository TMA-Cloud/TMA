import React, { useEffect, useState, useCallback } from 'react';
import { FolderSync } from 'lucide-react';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsItem } from '../components/SettingsItem';
import { useToast } from '../../../hooks/useToast';
import {
  hasElectronCloudDrive,
  getElectronCloudDriveMode,
  setElectronCloudDriveMode,
  type CloudDriveMode,
} from '../../../utils/electronDesktop';

/**
 * Desktop-only controls for the TMA Cloud drive (WinFsp mount). Lets the user
 * switch the drive to "save-only" mode: folders and files stay browsable and
 * Save-As keeps working, but opening/copying file content off the drive is
 * blocked — so people keep using the app to view files.
 *
 * Renders nothing outside the desktop app.
 */
export const CloudDriveSection: React.FC = () => {
  const { showToast } = useToast();
  const available = hasElectronCloudDrive();

  const [mode, setMode] = useState<CloudDriveMode>('full');
  const [mountPoint, setMountPoint] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!available) return;
    try {
      const m = await getElectronCloudDriveMode();
      setMode(m);
      const status = await window.electronAPI?.cloudDrive?.status?.();
      setMountPoint(status?.mountPoint ?? null);
    } finally {
      setLoaded(true);
    }
  }, [available]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleToggle = async () => {
    if (saving) return;
    const next: CloudDriveMode = mode === 'saveOnly' ? 'full' : 'saveOnly';
    setSaving(true);
    // Optimistic update; revert on failure.
    setMode(next);
    const res = await setElectronCloudDriveMode(next);
    setSaving(false);
    if (!res.ok) {
      setMode(mode);
      showToast(res.error || 'Failed to update cloud drive mode', 'error');
      return;
    }
    showToast(
      next === 'saveOnly'
        ? 'Cloud drive set to Save-only | Files can be browsed but not opened from the drive'
        : 'Cloud drive set to Full access',
      'success'
    );
  };

  if (!available) return null;

  const saveOnly = mode === 'saveOnly';

  return (
    <SettingsSection
      title="Cloud Drive"
      icon={FolderSync}
      description={
        mountPoint
          ? `Mounted as ${mountPoint} | Save to it from any app's "Save As" dialog`
          : 'Save to TMA Cloud | From any apps "Save As" dialog'
      }
    >
      <SettingsItem
        label="Save-only Mode"
        description="Browse folders and see files, but opening or copying files from the drive is blocked"
        toggle
        toggleValue={saveOnly}
        onToggle={handleToggle}
        toggleDisabled={!loaded || saving}
      />
    </SettingsSection>
  );
};
