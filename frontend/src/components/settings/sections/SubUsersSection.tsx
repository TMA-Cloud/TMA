import React from 'react';
import { Users, UserCog } from 'lucide-react';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsItem } from '../components/SettingsItem';
import { SettingsGroup } from '../components/SettingsGroup';
import { SettingsNote } from '../components/SettingsNote';
import { SettingsStat } from '../components/SettingsStat';

interface SubUsersSectionProps {
  subUserCount: number;
  loading: boolean;
  onManageSubUsers: () => void;
}

export const SubUsersSection: React.FC<SubUsersSectionProps> = ({ subUserCount, loading, onManageSubUsers }) => {
  return (
    <SettingsSection title="Sub-users" icon={Users} description="Separate logins for the same files">
      <div className="space-y-8">
        <div className="sm:max-w-xs">
          <SettingsStat
            icon={Users}
            label="Sub-users"
            value={subUserCount === 0 ? 'None yet' : subUserCount}
            hint="Share your files and quota, with their own sign-in"
            loading={loading}
          />
        </div>

        <SettingsGroup title="Management" description="Create sub-users and choose what each one may do.">
          <SettingsItem
            label="Sub-users"
            value=""
            action={loading ? 'Loading...' : 'Manage sub-users'}
            onAction={onManageSubUsers}
            actionDisabled={loading}
            actionIcon={UserCog}
            description="Add, remove, and set permissions"
          />
          {/* The explanation is prose, so it is no longer dressed as a settings row. */}
          <SettingsNote>
            Sub-users share your files and quota but sign in with their own credentials, so audit logs stay accurate.
            You choose their permissions; they can't create accounts.
          </SettingsNote>
        </SettingsGroup>
      </div>
    </SettingsSection>
  );
};
