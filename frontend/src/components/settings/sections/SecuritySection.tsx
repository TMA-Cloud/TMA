import React from 'react';
import { Shield, LogOut, Key, Lock } from 'lucide-react';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsItem } from '../components/SettingsItem';

interface SecuritySectionProps {
  activeSessionsCount: number;
  loadingSessions: boolean;
  loggingOutAll: boolean;
  onShowSessions: () => void;
  onLogoutAllDevices: () => void;
  onShowMfa: () => void;
  passwordChangeEnabled: boolean;
  onShowChangePassword: () => void;
}

export const SecuritySection: React.FC<SecuritySectionProps> = ({
  activeSessionsCount,
  loadingSessions,
  loggingOutAll,
  onShowSessions,
  onLogoutAllDevices,
  onShowMfa,
  passwordChangeEnabled,
  onShowChangePassword,
}) => {
  return (
    <SettingsSection title="Security" icon={Shield} description="Manage account security and active sessions">
      <SettingsItem
        label="Multi-Factor Authentication"
        value=""
        action="Manage MFA"
        onAction={onShowMfa}
        actionIcon={Key}
        description="Add an extra layer of security with two-factor authentication"
      />
      {passwordChangeEnabled && (
        <SettingsItem
          label="Password"
          value=""
          action="Change password"
          onAction={onShowChangePassword}
          actionIcon={Lock}
          description="Change account current password"
        />
      )}
      <SettingsItem
        label="Active Sessions"
        value=""
        action={loadingSessions ? 'Loading...' : 'View sessions'}
        onAction={onShowSessions}
        actionDisabled={loadingSessions}
        description={`View and manage all active sessions; ${activeSessionsCount > 0 ? `${activeSessionsCount} active session${activeSessionsCount === 1 ? '' : 's'}` : 'No active sessions'}`}
        loadingStates={{ sessions: loadingSessions }}
      />
      <SettingsItem
        label="Logout All Devices"
        value=""
        action={loggingOutAll ? 'Logging out...' : 'Logout everywhere'}
        onAction={onLogoutAllDevices}
        actionDisabled={loggingOutAll}
        actionIcon={LogOut}
        actionVariant="danger"
        description="Sign out from all devices and browsers. You will need to login again"
        loadingStates={{ logoutAll: loggingOutAll }}
      />
    </SettingsSection>
  );
};
