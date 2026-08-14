import React, { useState, useEffect, useCallback } from 'react';
import { User, HardDrive, Settings as SettingsIcon, RefreshCw, Shield, Users, Menu, X } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useApp } from '../../contexts/AppContext';
import { useStorageUsage } from '../../hooks/useStorageUsage';
import { fetchAllUsers, fetchActiveClients, type UserSummary, type ActiveClient } from '../../utils/api';
import { useToast } from '../../hooks/useToast';
import { isElectron } from '../../utils/electronDesktop';
import { formatFileSize } from '../../utils/fileUtils';

// Hooks
import { useSignupStatus } from './hooks/useSignupStatus';
import { useVersions } from './hooks/useVersions';
import { useSessions } from './hooks/useSessions';
import { useSubUsers } from './hooks/useSubUsers';

// Components
import { ProfileSection } from './sections/ProfileSection';
import { StorageSection } from './sections/StorageSection';
import { CloudDriveSection } from './sections/CloudDriveSection';
import { AdministrationSection } from './sections/AdministrationSection';
import { OnlyOfficeSection } from './sections/OnlyOfficeSection';
import { ShareBaseUrlSection } from './sections/ShareBaseUrlSection';
import { UpdatesSection } from './sections/UpdatesSection';
import { SecuritySection } from './sections/SecuritySection';
import { SubUsersSection } from './sections/SubUsersSection';

// Modals
import { UsersModal } from './modals/UsersModal';
import { SessionsModal } from './modals/SessionsModal';
import { ActiveClientsModal } from './modals/ActiveClientsModal';
import { OrphanFilesModal } from './modals/OrphanFilesModal';
import { MfaModal } from './modals/MfaModal';
import { ChangePasswordModal } from './modals/ChangePasswordModal';
import { SubUsersModal } from './modals/SubUsersModal';

type SectionId = 'profile' | 'storage' | 'sub-users' | 'administration' | 'updates' | 'security';

interface NavSection {
  id: SectionId;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  adminOnly?: boolean;
  /** Hidden for sub-users, who cannot manage sub-users of their own. */
  ownerOnly?: boolean;
}

const ALL_SECTIONS: NavSection[] = [
  { id: 'profile', label: 'Profile', icon: User },
  { id: 'storage', label: 'Storage', icon: HardDrive },
  { id: 'sub-users', label: 'Sub-users', icon: Users, ownerOnly: true },
  { id: 'administration', label: 'Administration', icon: SettingsIcon, adminOnly: true },
  { id: 'updates', label: 'Updates', icon: RefreshCw, adminOnly: true },
  { id: 'security', label: 'Security', icon: Shield },
];

export const Settings: React.FC = () => {
  const { user, isSubUser } = useAuth();
  const { setHideFileExtensions } = useApp();
  const { usage, loading: storageLoading, refresh: refreshStorage } = useStorageUsage();
  const { showToast } = useToast();

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
    allowPasswordChange,
    canToggleAllowPasswordChange,
    togglingAllowPasswordChange,
    handleToggleAllowPasswordChange,
  } = useSignupStatus({ onHideFileExtensionsChange: setHideFileExtensions });

  const {
    versionStatusText,
    versionDescription,
    checkingVersions,
    versionError,
    handleCheckVersions,
    latestElectronVersion,
  } = useVersions();

  const {
    activeSessions,
    loadingSessions,
    revokingSessionId,
    loggingOutAll,
    loadActiveSessions,
    handleRevokeSession,
    handleLogoutAllDevices,
  } = useSessions();

  const [usersModalOpen, setUsersModalOpen] = useState(false);
  const [usersList, setUsersList] = useState<UserSummary[]>([]);
  const [loadingUsersList, setLoadingUsersList] = useState(false);
  const [usersListError, setUsersListError] = useState<string | null>(null);
  const [sessionsModalOpen, setSessionsModalOpen] = useState(false);
  const [mfaModalOpen, setMfaModalOpen] = useState(false);
  const [changePasswordModalOpen, setChangePasswordModalOpen] = useState(false);

  const [activeClientsModalOpen, setActiveClientsModalOpen] = useState(false);
  const [activeClientsList, setActiveClientsList] = useState<ActiveClient[]>([]);
  const [loadingActiveClients, setLoadingActiveClients] = useState(false);

  const [orphansModalOpen, setOrphansModalOpen] = useState(false);
  const [subUsersModalOpen, setSubUsersModalOpen] = useState(false);

  const {
    subUsers,
    loading: loadingSubUsers,
    error: subUsersError,
    creating: creatingSubUser,
    updatingId: updatingSubUserId,
    deletingId: deletingSubUserId,
    loadSubUsers,
    createSubUser,
    updatePermissions: updateSubUserPermissions,
    removeSubUser,
    availablePermissions,
  } = useSubUsers();

  const [activeSection, setActiveSection] = useState<SectionId>('profile');
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const runningInElectron = isElectron();

  const visibleSections = ALL_SECTIONS.filter(s => (!s.adminOnly || canToggleSignup) && (!s.ownerOnly || !isSubUser));

  // If the selected section is no longer visible (e.g. admin toggled off), fall back to 'profile'.
  // Derived during render rather than syncing via setState in an effect.
  const effectiveActiveSection: SectionId = visibleSections.find(s => s.id === activeSection)
    ? activeSection
    : 'profile';

  const loadUsersList = async () => {
    try {
      setLoadingUsersList(true);
      setUsersListError(null);
      const { users } = await fetchAllUsers();
      setUsersList(users);
    } catch {
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

  const loadActiveClients = useCallback(
    async (silent = false) => {
      try {
        setLoadingActiveClients(true);
        const { clients } = await fetchActiveClients();
        setActiveClientsList(clients);
      } catch {
        if (!silent) showToast('Failed to load active clients', 'error');
      } finally {
        setLoadingActiveClients(false);
      }
    },
    [showToast]
  );

  useEffect(() => {
    if (canToggleSignup) Promise.resolve().then(() => loadActiveClients(true));
  }, [canToggleSignup, loadActiveClients]);

  // Preload the count so the section can show it without opening the modal.
  useEffect(() => {
    if (!isSubUser) Promise.resolve().then(() => loadSubUsers(true));
  }, [isSubUser, loadSubUsers]);

  const handleShowSubUsers = () => {
    setSubUsersModalOpen(true);
    loadSubUsers();
  };

  const handleShowActiveClients = () => {
    setActiveClientsModalOpen(true);
    loadActiveClients();
  };

  const handleNavClick = (id: SectionId) => {
    setActiveSection(id);
    setSidebarOpen(false);
  };

  const storageLabel = (() => {
    if (storageLoading || !usage) return 'Calculating...';
    const totalLabel = usage.total != null ? formatFileSize(usage.total) : 'Unlimited';
    return `${formatFileSize(usage.used)} of ${totalLabel}`;
  })();

  const renderActiveSection = () => {
    switch (effectiveActiveSection) {
      case 'profile':
        return (
          <ProfileSection
            userName={user?.name}
            userEmail={user?.email}
            userCreatedAt={user?.created_at}
            userMfaEnabled={user?.mfa_enabled}
          />
        );
      case 'storage':
        return (
          <div className="space-y-8">
            <StorageSection usage={usage ?? undefined} loading={storageLoading} canConfigure={canToggleSignup} />
            {runningInElectron && <CloudDriveSection />}
          </div>
        );
      case 'sub-users':
        return isSubUser ? null : (
          <SubUsersSection
            subUserCount={subUsers.length}
            loading={loadingSubUsers}
            onManageSubUsers={handleShowSubUsers}
          />
        );
      case 'administration':
        return canToggleSignup ? (
          <div className="space-y-8">
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
              allowPasswordChange={allowPasswordChange}
              canToggleAllowPasswordChange={canToggleAllowPasswordChange}
              togglingAllowPasswordChange={togglingAllowPasswordChange}
              onToggleAllowPasswordChange={handleToggleAllowPasswordChange}
              activeClientsCount={loadingActiveClients ? null : activeClientsList.length}
              loadingActiveClients={loadingActiveClients}
              onShowActiveClients={handleShowActiveClients}
              onShowOrphans={() => setOrphansModalOpen(true)}
            />
            <div className="pt-1">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400 mb-4">Integrations</p>
              <div className="space-y-6">
                <OnlyOfficeSection canConfigure={canToggleSignup} />
                <ShareBaseUrlSection canConfigure={canToggleSignup} />
              </div>
            </div>
          </div>
        ) : null;
      case 'updates':
        return canToggleSignup ? (
          <UpdatesSection
            versionStatusText={versionStatusText}
            versionDescription={versionDescription}
            checkingVersions={checkingVersions}
            versionError={versionError}
            onCheckVersions={handleCheckVersions}
            latestElectronVersion={latestElectronVersion}
          />
        ) : null;
      case 'security':
        return (
          <SecuritySection
            activeSessionsCount={activeSessions.length}
            loadingSessions={loadingSessions}
            loggingOutAll={loggingOutAll}
            onShowSessions={handleShowSessions}
            onLogoutAllDevices={handleLogoutAllDevices}
            onShowMfa={() => setMfaModalOpen(true)}
            passwordChangeEnabled={allowPasswordChange}
            onShowChangePassword={() => setChangePasswordModalOpen(true)}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div className="w-full h-full max-w-[1400px] mx-auto p-4 md:p-6 lg:p-8">
      <div className="flex h-full min-h-[calc(100vh-8rem)] rounded-2xl overflow-hidden border border-slate-200/60 dark:border-slate-700/40 bg-[#f2f2f7] dark:bg-slate-900/60 shadow-xl">
        {/* Mobile toggle: top-left when closed, snaps to drawer edge when open */}
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className={`
            fixed top-20 z-[60] md:hidden p-3 rounded-full bg-blue-500 text-white shadow-lg hover:bg-blue-600
            transition-all duration-300 ease-in-out
            ${sidebarOpen ? 'left-[calc(18rem-1rem)]' : 'left-4'}
          `}
          aria-label="Toggle settings menu"
        >
          {sidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>

        {/* Sidebar — mobile: below app header (h-16), above bottom nav z-40; desktop unchanged */}
        <aside
          className={`
            ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
            md:translate-x-0
            fixed md:static left-0 z-50 md:z-auto
            top-16 bottom-0 md:top-auto md:bottom-auto md:inset-y-0
            w-72 md:w-64 lg:w-72 shrink-0
            bg-[#e5e5ea] dark:bg-slate-800/90
            border-r border-slate-200/60 dark:border-slate-700/40
            flex flex-col min-h-0
            transition-motion duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]
          `}
        >
          {/* Sidebar header */}
          <div className="px-5 pt-4 pb-4 md:pt-6 border-b border-slate-300/50 dark:border-slate-700/50 shrink-0">
            <p className="uppercase tracking-[0.3em] text-[11px] font-semibold text-[#007aff]/80 mb-2">
              Control Center
            </p>
            <h1 className="text-2xl font-bold text-slate-800 dark:text-slate-100 tracking-tight">Settings</h1>
            {user?.name && (
              <div className="mt-3 flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-[var(--accent)] flex items-center justify-center text-white text-sm font-semibold shrink-0">
                  {user.name.charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-800 dark:text-slate-200 truncate">{user.name}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{user.email}</p>
                </div>
              </div>
            )}
          </div>

          {/* Storage mini-bar */}
          <div className="px-5 py-3 border-b border-slate-300/50 dark:border-slate-700/50">
            <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 mb-1.5">
              <span className="font-medium">Storage</span>
              <span>{storageLabel}</span>
            </div>
            <div className="h-1.5 w-full rounded-full bg-slate-300/80 dark:bg-slate-700/80 overflow-hidden">
              <div
                className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300"
                style={{
                  width:
                    usage && usage.total != null && usage.total > 0
                      ? `${Math.min(100, Math.max(1, Math.round((usage.used / usage.total) * 100)))}%`
                      : '0%',
                }}
              />
            </div>
          </div>

          {/* Navigation items */}
          <nav className="scroller flex-1 overflow-y-auto py-3 px-3" role="navigation" aria-label="Settings sections">
            <ul className="space-y-0.5">
              {visibleSections.map(section => {
                const Icon = section.icon;
                const isActive = effectiveActiveSection === section.id;
                return (
                  <li key={section.id}>
                    <button
                      onClick={() => handleNavClick(section.id)}
                      className={`
                        w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-150
                        ${
                          isActive
                            ? 'bg-[#007aff]/15 dark:bg-[#007aff]/20 text-[#0069e0] dark:text-blue-300 shadow-sm'
                            : 'text-slate-600 dark:text-slate-400 hover:bg-slate-300/40 dark:hover:bg-slate-700/40 hover:text-slate-800 dark:hover:text-slate-200'
                        }
                      `}
                    >
                      <Icon className={`w-[18px] h-[18px] shrink-0 ${isActive ? 'text-[#007aff]' : ''}`} />
                      <span className="truncate">{section.label}</span>
                      {isActive && <div className="ml-auto w-1.5 h-1.5 rounded-full bg-[#007aff]" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          {/* Sidebar footer */}
          <div className="px-5 py-4 border-t border-slate-300/50 dark:border-slate-700/50">
            <p className="text-[11px] text-slate-400 dark:text-slate-500">
              Manage your preferences and application controls
            </p>
          </div>
        </aside>

        {/* Mobile overlay: below main app header, covers content + bottom nav for clear focus */}
        {sidebarOpen && (
          <div
            className="fixed inset-x-0 top-16 bottom-0 z-[45] bg-black/50 md:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-hidden
          />
        )}

        {/* Content panel */}
        <main className="scroller flex-1 min-w-0 overflow-y-auto">
          <div className="p-6 md:p-8 lg:p-10">
            <div key={effectiveActiveSection} style={{ animation: 'fadeIn 0.3s ease both' }}>
              {renderActiveSection()}
            </div>
          </div>
        </main>
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

      <ActiveClientsModal
        isOpen={activeClientsModalOpen}
        onClose={() => setActiveClientsModalOpen(false)}
        clients={activeClientsList}
        loading={loadingActiveClients}
        onRefresh={loadActiveClients}
      />

      <OrphanFilesModal isOpen={orphansModalOpen} onClose={() => setOrphansModalOpen(false)} />

      <SubUsersModal
        isOpen={subUsersModalOpen}
        onClose={() => setSubUsersModalOpen(false)}
        subUsers={subUsers}
        availablePermissions={availablePermissions}
        loading={loadingSubUsers}
        error={subUsersError}
        creating={creatingSubUser}
        updatingId={updatingSubUserId}
        deletingId={deletingSubUserId}
        onRefresh={() => loadSubUsers()}
        onCreate={createSubUser}
        onUpdatePermissions={updateSubUserPermissions}
        onRemove={removeSubUser}
      />

      <MfaModal isOpen={mfaModalOpen} onClose={() => setMfaModalOpen(false)} />
      <ChangePasswordModal isOpen={changePasswordModalOpen} onClose={() => setChangePasswordModalOpen(false)} />
    </div>
  );
};

export default Settings;
