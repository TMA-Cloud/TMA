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
        description="Require a second step when signing in"
      />
      {passwordChangeEnabled && (
        <SettingsItem
          label="Password"
          value=""
          action="Change password"
          onAction={onShowChangePassword}
          actionIcon={Lock}
          description="Set a new account password"
        />
      )}
      <SettingsItem
        label="Active Sessions"
        value=""
        action={loadingSessions ? 'Loading...' : 'View sessions'}
        onAction={onShowSessions}
        actionDisabled={loadingSessions}
        description={
          activeSessionsCount > 0
            ? `${activeSessionsCount} active session${activeSessionsCount === 1 ? '' : 's'}`
            : 'No active sessions'
        }
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
        description="Ends every session, including this one"
        loadingStates={{ logoutAll: loggingOutAll }}
      />
    </SettingsSection>
  );
};
