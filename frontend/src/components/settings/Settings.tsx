import React, { useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useApp } from '../../contexts/AppContext';
import { useStorageUsage } from '../../hooks/useStorageUsage';
import { fetchAllUsers, type UserSummary } from '../../utils/api';
import { useToast } from '../../hooks/useToast';
import { isElectron } from '../../utils/electronDesktop';

// Hooks
import { useSignupStatus } from './hooks/useSignupStatus';
import { useVersions } from './hooks/useVersions';
import { useSessions } from './hooks/useSessions';

// Components
import { SettingsHeader } from './components/SettingsHeader';
import { ProfileSection } from './sections/ProfileSection';
import { StorageSection } from './sections/StorageSection';
import { AdministrationSection } from './sections/AdministrationSection';
import { OnlyOfficeSection } from './sections/OnlyOfficeSection';
import { ShareBaseUrlSection } from './sections/ShareBaseUrlSection';
import { UpdatesSection } from './sections/UpdatesSection';
import { SecuritySection } from './sections/SecuritySection';

// Modals
import { UsersModal } from './modals/UsersModal';
import { SessionsModal } from './modals/SessionsModal';
import { MfaModal } from './modals/MfaModal';

export const Settings: React.FC = () => {
  const { user } = useAuth();
  const { setHideFileExtensions } = useApp();
  const { usage, loading, refresh: refreshStorage } = useStorageUsage();
  const { showToast } = useToast();

  // Signup status hook (syncs hideFileExtensions to AppContext when admin toggles)
  const {
    signupEnabled,
    canToggleSignup,
    totalUsers,
    additionalUsers,
    loadingSignupStatus,
    togglingSignup,
    handleToggleSignup,
    hideFileExtensions,
    canToggleHideFileExtensions,
    togglingHideFileExtensions,
    handleToggleHideFileExtensions,
    electronOnlyAccess,
    canToggleElectronOnlyAccess,
    togglingElectronOnlyAccess,
    handleToggleElectronOnlyAccess,
  } = useSignupStatus({ onHideFileExtensionsChange: setHideFileExtensions });

  // Versions hook
  const {
    versionStatusText,
    versionDescription,
    checkingVersions,
    versionError,
    handleCheckVersions,
    latestElectronVersion,
  } = useVersions();

  // Sessions hook
  const {
    activeSessions,
    loadingSessions,
    revokingSessionId,
    loggingOutAll,
    loadActiveSessions,
    handleRevokeSession,
    handleLogoutAllDevices,
  } = useSessions();

  // Users modal state
  const [usersModalOpen, setUsersModalOpen] = useState(false);
  const [usersList, setUsersList] = useState<UserSummary[]>([]);
  const [loadingUsersList, setLoadingUsersList] = useState(false);
  const [usersListError, setUsersListError] = useState<string | null>(null);
  const [sessionsModalOpen, setSessionsModalOpen] = useState(false);
  const [mfaModalOpen, setMfaModalOpen] = useState(false);

  // Data is loaded automatically by hooks on mount

  const runningInElectron = isElectron();

  const loadUsersList = async () => {
    try {
      setLoadingUsersList(true);
      setUsersListError(null);
      const { users } = await fetchAllUsers();
      setUsersList(users);
    } catch {
      // Error handled by toast notification and error state
      setUsersListError('Unable to load users right now');
      showToast('Failed to load user list', 'error');
    } finally {
      setLoadingUsersList(false);
    }
  };

  const handleShowUsers = () => {
    setUsersModalOpen(true);
    loadUsersList();
  };

  const handleShowSessions = () => {
    setSessionsModalOpen(true);
    loadActiveSessions();
  };

  return (
    <div className="w-full max-w-7xl mx-auto p-8 md:p-10 space-y-10">
      <SettingsHeader userName={user?.name} usage={usage ?? undefined} loading={loading} />
      {/* Settings Sections */}
      <div className="space-y-10">
        <ProfileSection userName={user?.name} userEmail={user?.email} />

        <StorageSection usage={usage ?? undefined} loading={loading} canConfigure={canToggleSignup} />

        {canToggleSignup && (
          <AdministrationSection
            loadingSignupStatus={loadingSignupStatus}
            additionalUsers={additionalUsers}
            totalUsers={totalUsers}
            signupEnabled={signupEnabled}
            loadingUsersList={loadingUsersList}
            onToggleSignup={handleToggleSignup}
            togglingSignup={togglingSignup}
            onShowUsers={handleShowUsers}
            hideFileExtensions={hideFileExtensions}
            canToggleHideFileExtensions={canToggleHideFileExtensions}
            togglingHideFileExtensions={togglingHideFileExtensions}
            onToggleHideFileExtensions={handleToggleHideFileExtensions}
            electronOnlyAccess={electronOnlyAccess}
            canToggleElectronOnlyAccess={canToggleElectronOnlyAccess}
            togglingElectronOnlyAccess={togglingElectronOnlyAccess}
            onToggleElectronOnlyAccess={handleToggleElectronOnlyAccess}
            showElectronOnlyAccessToggle={runningInElectron}
          />
        )}

        {canToggleSignup && <OnlyOfficeSection canConfigure={canToggleSignup} />}

        {canToggleSignup && <ShareBaseUrlSection canConfigure={canToggleSignup} />}

        {canToggleSignup && (
          <UpdatesSection
            versionStatusText={versionStatusText}
            versionDescription={versionDescription}
            checkingVersions={checkingVersions}
            versionError={versionError}
            onCheckVersions={handleCheckVersions}
            latestElectronVersion={latestElectronVersion}
          />
        )}

        <SecuritySection
          activeSessionsCount={activeSessions.length}
          loadingSessions={loadingSessions}
          loggingOutAll={loggingOutAll}
          onShowSessions={handleShowSessions}
          onLogoutAllDevices={handleLogoutAllDevices}
          onShowMfa={() => setMfaModalOpen(true)}
        />
      </div>

      {/* Modals */}
      <UsersModal
        isOpen={usersModalOpen}
        onClose={() => setUsersModalOpen(false)}
        usersList={usersList}
        loadingUsersList={loadingUsersList}
        usersListError={usersListError}
        onRefresh={loadUsersList}
        onStorageUpdated={refreshStorage}
        currentUserId={user?.id}
      />

      <SessionsModal
        isOpen={sessionsModalOpen}
        onClose={() => setSessionsModalOpen(false)}
        activeSessions={activeSessions}
        loadingSessions={loadingSessions}
        revokingSessionId={revokingSessionId}
        onRefresh={loadActiveSessions}
        onRevokeSession={handleRevokeSession}
      />

      <MfaModal isOpen={mfaModalOpen} onClose={() => setMfaModalOpen(false)} />
    </div>
  );
};

export default Settings;
