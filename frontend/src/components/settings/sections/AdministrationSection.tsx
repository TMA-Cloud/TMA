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
    </SettingsSection>
  );
};
