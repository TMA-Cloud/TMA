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
    <SettingsSection
      title="Sub-users"
      icon={Users}
      description="Give colleagues their own login to the same files and storage"
    >
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
        description="Sub-users share your files and storage quota, but log in with separate credentials to ensure accurate audit logs. You customize their exact permissions (upload, download, modify, share, etc.). Sub-users cannot create additional accounts."
      />
    </SettingsSection>
  );
};
