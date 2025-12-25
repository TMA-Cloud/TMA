import React, { useState } from "react";
import { useAuth } from "../../contexts/AuthContext";
import { useStorageUsage } from "../../hooks/useStorageUsage";
import { fetchAllUsers, type UserSummary } from "../../utils/api";
import { useToast } from "../../hooks/useToast";

// Hooks
import { useSignupStatus } from "./hooks/useSignupStatus";
import { useVersions } from "./hooks/useVersions";
import { useSessions } from "./hooks/useSessions";
import { useCustomDriveManagement } from "./hooks/useCustomDriveManagement";

// Components
import { SettingsHeader } from "./components/SettingsHeader";
import { ProfileSection } from "./sections/ProfileSection";
import { StorageSection } from "./sections/StorageSection";
import { CustomDriveManagementSection } from "./sections/CustomDriveManagementSection";
import { AdministrationSection } from "./sections/AdministrationSection";
import { UpdatesSection } from "./sections/UpdatesSection";
import { SecuritySection } from "./sections/SecuritySection";

// Modals
import { UsersModal } from "./modals/UsersModal";
import { SessionsModal } from "./modals/SessionsModal";
import { CustomDriveEnableModal } from "./modals/CustomDriveEnableModal";
import { CustomDriveDisableModal } from "./modals/CustomDriveDisableModal";

export const Settings: React.FC = () => {
  const { user } = useAuth();
  const { usage, loading } = useStorageUsage();
  const { showToast } = useToast();

  // Signup status hook
  const {
    signupEnabled,
    canToggleSignup,
    totalUsers,
    additionalUsers,
    loadingSignupStatus,
    togglingSignup,
    handleToggleSignup,
  } = useSignupStatus();

  // Versions hook
  const {
    versionStatusText,
    versionDescription,
    checkingVersions,
    versionError,
    handleCheckVersions,
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

  // Custom drive management hook
  const {
    allUsersCustomDrive,
    loadingAllUsersCustomDrive,
    updatingUserCustomDrive,
    userCustomDriveLocalState,
    setUserCustomDriveLocalState,
    confirmingUserId,
    confirmingAction,
    handleUpdateUserCustomDrive,
    handleConfirmEnable,
    handleConfirmDisable,
    handleCancelConfirmation,
    handleProceedEnable,
    handleProceedDisable,
  } = useCustomDriveManagement(canToggleSignup);

  // Users modal state
  const [usersModalOpen, setUsersModalOpen] = useState(false);
  const [usersList, setUsersList] = useState<UserSummary[]>([]);
  const [loadingUsersList, setLoadingUsersList] = useState(false);
  const [usersListError, setUsersListError] = useState<string | null>(null);
  const [sessionsModalOpen, setSessionsModalOpen] = useState(false);

  // Data is loaded automatically by hooks on mount

  const loadUsersList = async () => {
    try {
      setLoadingUsersList(true);
      setUsersListError(null);
      const { users } = await fetchAllUsers();
      setUsersList(users);
    } catch (error) {
      console.error("Failed to load users list:", error);
      setUsersListError("Unable to load users right now");
      showToast("Failed to load user list", "error");
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

  const confirmingUserInfo = confirmingUserId
    ? allUsersCustomDrive.find((u) => u.id === confirmingUserId)
    : undefined;

  const confirmingLocalState = confirmingUserId
    ? userCustomDriveLocalState[confirmingUserId]
    : undefined;

  return (
    <div className="p-6 md:p-8 space-y-8">
      <SettingsHeader
        userName={user?.name}
        usage={usage ?? undefined}
        loading={loading}
      />

      {/* Settings Sections */}
      <div className="space-y-8">
        <ProfileSection userName={user?.name} userEmail={user?.email} />

        <StorageSection usage={usage ?? undefined} loading={loading} />

        {canToggleSignup && (
          <CustomDriveManagementSection
            allUsersCustomDrive={allUsersCustomDrive}
            loadingAllUsersCustomDrive={loadingAllUsersCustomDrive}
            updatingUserCustomDrive={updatingUserCustomDrive}
            userCustomDriveLocalState={userCustomDriveLocalState}
            setUserCustomDriveLocalState={setUserCustomDriveLocalState}
            onConfirmEnable={handleConfirmEnable}
            onConfirmDisable={handleConfirmDisable}
            onUpdateUserCustomDrive={handleUpdateUserCustomDrive}
          />
        )}

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
          />
        )}

        <UpdatesSection
          versionStatusText={versionStatusText}
          versionDescription={versionDescription}
          checkingVersions={checkingVersions}
          versionError={versionError}
          onCheckVersions={handleCheckVersions}
        />

        <SecuritySection
          activeSessionsCount={activeSessions.length}
          loadingSessions={loadingSessions}
          loggingOutAll={loggingOutAll}
          onShowSessions={handleShowSessions}
          onLogoutAllDevices={handleLogoutAllDevices}
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

      <CustomDriveEnableModal
        isOpen={confirmingAction === "enable" && confirmingUserId !== null}
        onClose={handleCancelConfirmation}
        userInfo={confirmingUserInfo}
        onCancel={handleCancelConfirmation}
        onProceed={handleProceedEnable}
      />

      <CustomDriveDisableModal
        isOpen={confirmingAction === "disable" && confirmingUserId !== null}
        onClose={handleCancelConfirmation}
        userInfo={confirmingUserInfo}
        localState={confirmingLocalState}
        updating={updatingUserCustomDrive === confirmingUserId}
        onCancel={handleCancelConfirmation}
        onProceed={handleProceedDisable}
      />
    </div>
  );
};
