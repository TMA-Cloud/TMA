import React from 'react';
import { User, ShieldCheck, KeyRound } from 'lucide-react';
import { SettingsSection } from '../components/SettingsSection';
import { SettingsItem } from '../components/SettingsItem';
import { SettingsGroup } from '../components/SettingsGroup';
import { StatusChip } from '../components/StatusChip';

interface ProfileSectionProps {
  userName?: string;
  userEmail?: string;
  userCreatedAt?: string;
  userMfaEnabled?: boolean;
  /** Sub-users share the owner's files but sign in with their own login. */
  isSubUser?: boolean;
  /** Jumps to the Security section, where the MFA state can actually be changed. */
  onManageSecurity?: () => void;
}

function formatCreatedDate(value?: string): string {
  if (!value) return 'Unknown';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'Unknown';
  return parsed.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * Identity, shown as identity.
 *
 * Name, email and join date are facts about the reader, not settings they can
 * change here, so they belong in a profile card rather than in four rows that
 * look exactly like the toggles elsewhere in Settings. MFA state stays visible
 * because people look for it here, but it links to Security instead of
 * pretending to be adjustable on this screen.
 */
export const ProfileSection: React.FC<ProfileSectionProps> = ({
  userName,
  userEmail,
  userCreatedAt,
  userMfaEnabled,
  isSubUser,
  onManageSecurity,
}) => {
  const initial = (userName || userEmail || '?').charAt(0).toUpperCase();

  return (
    <SettingsSection title="Profile" icon={User} description="Who you are signed in as">
      <div className="space-y-8">
        <div className="flex flex-col sm:flex-row sm:items-center gap-4 rounded-2xl bg-white/60 dark:bg-gray-900/50 border border-slate-200/50 dark:border-slate-700/30 px-5 py-5">
          <div className="w-14 h-14 shrink-0 rounded-full bg-[var(--accent)] flex items-center justify-center text-white type-title-3 font-semibold">
            {initial}
          </div>
          <div className="min-w-0 flex-1">
            <p className="type-title-3 text-gray-900 dark:text-gray-100 truncate">{userName || 'Unnamed account'}</p>
            <p className="type-footnote text-gray-500 dark:text-gray-400 truncate">{userEmail || 'No email on file'}</p>
          </div>
          <StatusChip tone="neutral" icon={null} className="self-start sm:self-auto">
            {isSubUser ? 'Sub-user' : 'Account owner'}
          </StatusChip>
        </div>

        <SettingsGroup title="Account details" description="Recorded when the account was created.">
          <SettingsItem label="Email address" value={userEmail || 'Not set'} description="Used to sign in" />
          <SettingsItem
            label="Member since"
            value={formatCreatedDate(userCreatedAt)}
            description="The day this account was created"
          />
          <SettingsItem
            label="Account type"
            value={isSubUser ? 'Sub-user' : 'Account owner'}
            description={
              isSubUser
                ? "You share the owner's files and quota, with the permissions they granted"
                : 'You own these files and can grant sub-users access to them'
            }
          />
        </SettingsGroup>

        <SettingsGroup title="Sign-in security" description="Changed in the Security section.">
          <SettingsItem
            label="Multi-factor authentication"
            value=""
            action={userMfaEnabled ? 'Manage MFA' : 'Set up MFA'}
            actionIcon={userMfaEnabled ? ShieldCheck : KeyRound}
            onAction={onManageSecurity}
            actionDisabled={!onManageSecurity}
            description={
              userMfaEnabled ? 'A second step is required when you sign in' : 'Your password alone can sign you in'
            }
          />
        </SettingsGroup>
      </div>
    </SettingsSection>
  );
};
