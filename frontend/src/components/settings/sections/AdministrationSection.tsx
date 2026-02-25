import React from 'react';
import { Settings as SettingsIcon } from 'lucide-react';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsItem } from '../components/SettingsItem';

interface AdministrationSectionProps {
  loadingSignupStatus: boolean;
  additionalUsers: number | null;
  totalUsers: number | null;
  signupEnabled: boolean;
  loadingUsersList: boolean;
  onToggleSignup: () => void;
  togglingSignup: boolean;
  onShowUsers: () => void;
  hideFileExtensions: boolean;
  canToggleHideFileExtensions: boolean;
  togglingHideFileExtensions: boolean;
  onToggleHideFileExtensions: () => void;
}

export const AdministrationSection: React.FC<AdministrationSectionProps> = ({
  loadingSignupStatus,
  additionalUsers,
  totalUsers,
  signupEnabled,
  loadingUsersList,
  onToggleSignup,
  togglingSignup,
  onShowUsers,
  hideFileExtensions,
  canToggleHideFileExtensions,
  togglingHideFileExtensions,
  onToggleHideFileExtensions,
}) => {
  return (
    <SettingsSection
      title="Administration"
      icon={SettingsIcon}
      description="Manage workspace access, visibility, and onboarding."
    >
      <SettingsItem
        label="Other Registered Users"
        value={
          loadingSignupStatus
            ? 'Loading...'
            : additionalUsers === null
              ? 'Unavailable'
              : additionalUsers === 0
                ? 'No other users yet'
                : `${additionalUsers} ${additionalUsers === 1 ? 'user' : 'users'}`
        }
      />
      <SettingsItem
        label="Total Users (including you)"
        value={loadingSignupStatus ? 'Loading...' : totalUsers === null ? 'Unavailable' : totalUsers.toString()}
      />
      <SettingsItem
        label="Registered Users"
        value=""
        action={loadingUsersList ? 'Loading...' : 'Show all users'}
        onAction={onShowUsers}
        actionDisabled={loadingUsersList}
        description="Review every account currently registered"
        loadingStates={{ usersList: loadingUsersList }}
      />
      <SettingsItem
        label="Allow User Signup"
        value={signupEnabled.toString()}
        toggle={true}
        toggleValue={signupEnabled}
        onToggle={onToggleSignup}
        toggleDisabled={togglingSignup || loadingSignupStatus}
        description="Enable or disable new user registration"
      />
      <SettingsItem
        label="Hide file extensions"
        value={hideFileExtensions ? 'Yes' : 'No'}
        toggle={true}
        toggleValue={hideFileExtensions}
        onToggle={onToggleHideFileExtensions}
        toggleDisabled={!canToggleHideFileExtensions || togglingHideFileExtensions || loadingSignupStatus}
        description="Show file names without extensions in the file manager and rename dialog"
      />
    </SettingsSection>
  );
};
