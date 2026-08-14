import React from 'react';
import { Users, UserCog } from 'lucide-react';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsItem } from '../components/SettingsItem';

interface SubUsersSectionProps {
  subUserCount: number;
  loading: boolean;
  onManageSubUsers: () => void;
}

export const SubUsersSection: React.FC<SubUsersSectionProps> = ({ subUserCount, loading, onManageSubUsers }) => {
  const countLabel = (() => {
    if (loading) return 'Loading sub-users...';
    if (subUserCount === 0) return 'No sub-users yet';
    return `${subUserCount} sub-user${subUserCount === 1 ? '' : 's'} share this account`;
  })();

  return (
    <SettingsSection title="Sub-users" icon={Users} description="Separate logins for the same files">
      <SettingsItem
        label="Sub-users"
        value=""
        action={loading ? 'Loading...' : 'Manage sub-users'}
        onAction={onManageSubUsers}
        actionDisabled={loading}
        actionIcon={UserCog}
        description={countLabel}
      />
      <SettingsItem
        label="How sub-users work"
        value=""
        description="Sub-users share your files and quota but sign in with their own credentials, so audit logs stay accurate. You choose their permissions; they can't create accounts."
      />
    </SettingsSection>
  );
};
