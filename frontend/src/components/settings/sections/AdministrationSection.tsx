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
  electronOnlyAccess: boolean;
  canToggleElectronOnlyAccess: boolean;
  togglingElectronOnlyAccess: boolean;
  onToggleElectronOnlyAccess: () => void;
  showElectronOnlyAccessToggle: boolean;
  allowPasswordChange: boolean;
  canToggleAllowPasswordChange: boolean;
  togglingAllowPasswordChange: boolean;
  onToggleAllowPasswordChange: () => void;
  activeClientsCount: number | null;
  loadingActiveClients: boolean;
  onShowActiveClients: () => void;
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
  electronOnlyAccess,
  canToggleElectronOnlyAccess,
  togglingElectronOnlyAccess,
  onToggleElectronOnlyAccess,
  showElectronOnlyAccessToggle,
  allowPasswordChange,
  canToggleAllowPasswordChange,
  togglingAllowPasswordChange,
  onToggleAllowPasswordChange,
  activeClientsCount,
  loadingActiveClients,
  onShowActiveClients,
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
        label="Active Desktop Clients"
        value={
          loadingActiveClients
            ? 'Loading...'
            : activeClientsCount === null
              ? 'Unavailable'
              : activeClientsCount === 0
                ? 'None online'
                : `${activeClientsCount} online`
        }
        action={loadingActiveClients ? 'Loading...' : 'View clients'}
        onAction={onShowActiveClients}
        actionDisabled={loadingActiveClients}
        description="See all Electron desktop apps connected in the last 5 minutes"
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
      <SettingsItem
        label="Allow password change"
        value={allowPasswordChange ? 'Enabled' : 'Disabled'}
        toggle={true}
        toggleValue={allowPasswordChange}
        onToggle={onToggleAllowPasswordChange}
        toggleDisabled={!canToggleAllowPasswordChange || togglingAllowPasswordChange || loadingSignupStatus}
        description="Allow users to change their account password from the Security settings"
      />
      {showElectronOnlyAccessToggle && (
        <SettingsItem
          label="Desktop app only access"
          value={electronOnlyAccess ? 'Enabled' : 'Disabled'}
          toggle={true}
          toggleValue={electronOnlyAccess}
          onToggle={onToggleElectronOnlyAccess}
          toggleDisabled={!canToggleElectronOnlyAccess || togglingElectronOnlyAccess || loadingSignupStatus}
          description="When enabled, this instance can only be accessed via the desktop app (browsers will be blocked)"
        />
      )}
    </SettingsSection>
  );
};
