import React from 'react';
import { Shield, LogOut, Key, Lock, MonitorSmartphone } from 'lucide-react';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsItem } from '../components/SettingsItem';
import { SettingsGroup } from '../components/SettingsGroup';
import { SettingsNote } from '../components/SettingsNote';

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

/**
 * Sign-in credentials first, then the devices holding a session, then the one
 * action that ends them all.
 *
 * "Logout everywhere" signs the reader out of the device they are sitting at,
 * so it gets the same treatment as the maintenance actions in Administration:
 * its own framed zone at the bottom, away from the rows people click casually.
 */
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
  const sessionsLabel = loadingSessions
    ? 'Counting active sessions...'
    : activeSessionsCount > 0
      ? `${activeSessionsCount} active session${activeSessionsCount === 1 ? '' : 's'}, including this one`
      : 'No other devices are signed in';

  return (
    <SettingsSection title="Security" icon={Shield} description="Credentials and signed-in devices">
      <div className="space-y-8">
        <SettingsGroup title="Sign-in" description="What it takes to get into this account.">
          <SettingsItem
            label="Multi-Factor Authentication"
            value=""
            action="Manage MFA"
            onAction={onShowMfa}
            actionIcon={Key}
            description="Require a second step when signing in"
          />
          {passwordChangeEnabled ? (
            <SettingsItem
              label="Password"
              value=""
              action="Change password"
              onAction={onShowChangePassword}
              actionIcon={Lock}
              description="Set a new account password"
            />
          ) : (
            <SettingsNote>Password changes are turned off for this deployment.</SettingsNote>
          )}
        </SettingsGroup>

        <SettingsGroup title="Devices" description="Where this account is currently signed in.">
          <SettingsItem
            label="Active Sessions"
            value=""
            action={loadingSessions ? 'Loading...' : 'View sessions'}
            onAction={onShowSessions}
            actionDisabled={loadingSessions}
            actionIcon={MonitorSmartphone}
            description={sessionsLabel}
            loadingStates={{ sessions: loadingSessions }}
          />
        </SettingsGroup>

        <SettingsGroup
          title="Danger zone"
          tone="danger"
          description="This ends every session, including the one you are using right now — you will have to sign in again."
        >
          <SettingsItem
            label="Logout All Devices"
            value=""
            action={loggingOutAll ? 'Logging out...' : 'Logout everywhere'}
            onAction={onLogoutAllDevices}
            actionDisabled={loggingOutAll}
            actionIcon={LogOut}
            actionVariant="danger"
            description="Revokes every active session at once"
            loadingStates={{ logoutAll: loggingOutAll }}
          />
        </SettingsGroup>
      </div>
    </SettingsSection>
  );
};
