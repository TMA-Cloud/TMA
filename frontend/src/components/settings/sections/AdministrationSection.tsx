import React from 'react';
import { Settings as SettingsIcon, Trash2, Users, UserPlus, MonitorSmartphone } from 'lucide-react';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsItem } from '../components/SettingsItem';
import { SettingsGroup } from '../components/SettingsGroup';
import { SettingsStat } from '../components/SettingsStat';

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
  onShowOrphans: () => void;
  /** Collapsible server-configuration cards, grouped by what they configure. */
  networking?: React.ReactNode;
  integrations?: React.ReactNode;
}

/**
 * The Administration page.
 *
 * Ordered so a reader meets the state of the workspace before the controls
 * that change it, and so each band holds one kind of control: figures, then
 * switches, then drill-ins, then the configuration cards, with maintenance
 * last inside its own frame. Mixing a destructive "Review orphans" button in
 * among the switches — as this page used to — is what the separation is for.
 */
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
  onShowOrphans,
  networking,
  integrations,
}) => {
  const otherUsersLabel =
    additionalUsers === null ? null : additionalUsers === 0 ? 'None yet' : additionalUsers.toString();
  const activeClientsLabel =
    activeClientsCount === null ? null : activeClientsCount === 0 ? 'None online' : activeClientsCount.toString();

  return (
    <SettingsSection title="Administration" icon={SettingsIcon} description="Access, visibility, and maintenance">
      <div className="space-y-8">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 [&>*:last-child]:col-span-2 sm:[&>*:last-child]:col-span-1">
          <SettingsStat
            icon={Users}
            label="Total users"
            value={totalUsers}
            hint="Including you"
            loading={loadingSignupStatus}
          />
          <SettingsStat
            icon={UserPlus}
            label="Other users"
            value={otherUsersLabel}
            hint={signupEnabled ? 'Signup is open' : 'Signup is closed'}
            loading={loadingSignupStatus}
          />
          <SettingsStat
            icon={MonitorSmartphone}
            label="Active desktop clients"
            value={activeClientsLabel}
            hint="Seen in the last 5 minutes"
            loading={loadingActiveClients}
          />
        </div>

        <SettingsGroup title="Policies" description="Rules applied to everyone who uses this workspace.">
          <SettingsItem
            label="Allow user signup"
            value={signupEnabled ? 'Enabled' : 'Disabled'}
            toggle={true}
            toggleValue={signupEnabled}
            onToggle={onToggleSignup}
            toggleDisabled={togglingSignup || loadingSignupStatus}
            description="Let new people register their own account"
          />
          <SettingsItem
            label="Allow password change"
            value={allowPasswordChange ? 'Enabled' : 'Disabled'}
            toggle={true}
            toggleValue={allowPasswordChange}
            onToggle={onToggleAllowPasswordChange}
            toggleDisabled={!canToggleAllowPasswordChange || togglingAllowPasswordChange || loadingSignupStatus}
            description="Let users change their own password"
          />
          {showElectronOnlyAccessToggle && (
            <SettingsItem
              label="Desktop app only access"
              value={electronOnlyAccess ? 'Enabled' : 'Disabled'}
              toggle={true}
              toggleValue={electronOnlyAccess}
              onToggle={onToggleElectronOnlyAccess}
              toggleDisabled={!canToggleElectronOnlyAccess || togglingElectronOnlyAccess || loadingSignupStatus}
              description="Block browsers — sign-in from the desktop app only"
            />
          )}
          <SettingsItem
            label="Hide file extensions"
            value={hideFileExtensions ? 'Yes' : 'No'}
            toggle={true}
            toggleValue={hideFileExtensions}
            onToggle={onToggleHideFileExtensions}
            toggleDisabled={!canToggleHideFileExtensions || togglingHideFileExtensions || loadingSignupStatus}
            description="Show file names without their extensions"
          />
        </SettingsGroup>

        <SettingsGroup title="People & devices" description="Review who holds an account and what is connected.">
          <SettingsItem
            label="Registered Users"
            value=""
            action={loadingUsersList ? 'Loading...' : 'Show all users'}
            onAction={onShowUsers}
            actionDisabled={loadingUsersList}
            description="Every account currently registered, with its storage use"
            loadingStates={{ usersList: loadingUsersList }}
          />
          <SettingsItem
            label="Active Desktop Clients"
            value=""
            action={loadingActiveClients ? 'Loading...' : 'View clients'}
            onAction={onShowActiveClients}
            actionDisabled={loadingActiveClients}
            actionIcon={MonitorSmartphone}
            description="Desktop apps that checked in within the last 5 minutes"
          />
        </SettingsGroup>

        {networking && (
          <SettingsGroup title="Networking" description="How the server reads requests that arrive through a proxy.">
            {networking}
          </SettingsGroup>
        )}

        {integrations && (
          <SettingsGroup title="Integrations" description="External services this workspace talks to.">
            {integrations}
          </SettingsGroup>
        )}

        <SettingsGroup
          title="Maintenance"
          tone="danger"
          description="These actions delete data and cannot be undone. Review what is listed before confirming."
        >
          <SettingsItem
            label="Orphaned files"
            value=""
            action="Review orphans"
            actionIcon={Trash2}
            actionVariant="danger"
            onAction={onShowOrphans}
            description="Find stored files with no database record, and records with no file"
          />
        </SettingsGroup>
      </div>
    </SettingsSection>
  );
};
