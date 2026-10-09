import React from 'react';
import { SettingsItem } from '../components/SettingsItem';
import { useCloudDrivePolicy } from '../hooks/useCloudDrivePolicy';

/** The first user's Cloud Drive save-only switch, applied to every desktop app. */
export const CloudDrivePolicySetting: React.FC<{ canConfigure: boolean }> = ({ canConfigure }) => {
  const { saveOnly, loading, saving, toggle } = useCloudDrivePolicy(canConfigure);

  return (
    <SettingsItem
      label="Cloud Drive save-only"
      value={saveOnly === null ? '' : saveOnly ? 'Enabled' : 'Disabled'}
      toggle={true}
      toggleValue={saveOnly === true}
      onToggle={toggle}
      toggleDisabled={!canConfigure || saveOnly === null || loading || saving}
      description="Desktop apps can browse the drive and save into it, but not open files from it"
    />
  );
};
