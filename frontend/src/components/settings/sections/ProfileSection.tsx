import React from 'react';
import { User } from 'lucide-react';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsItem } from '../components/SettingsItem';

interface ProfileSectionProps {
  userName?: string;
  userEmail?: string;
  userCreatedAt?: string;
  userMfaEnabled?: boolean;
}

function formatCreatedDate(value?: string): string {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '-';
  return parsed.toLocaleDateString();
}

export const ProfileSection: React.FC<ProfileSectionProps> = ({
  userName,
  userEmail,
  userCreatedAt,
  userMfaEnabled,
}) => {
  return (
    <SettingsSection title="Profile" icon={User} description="Personal information">
      <SettingsItem label="Full Name" value={userName || ''} />
      <SettingsItem label="Email" value={userEmail || ''} />
      <SettingsItem label="Created At" value={formatCreatedDate(userCreatedAt)} />
      <SettingsItem label="MFA Status" value={userMfaEnabled ? 'Enabled' : 'Disabled'} />
    </SettingsSection>
  );
};
