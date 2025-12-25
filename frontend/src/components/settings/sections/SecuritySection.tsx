import React from "react";
import { Shield, LogOut } from "lucide-react";
import { SettingsSection } from "../components/SettingsSection";
import { SettingsItem } from "../components/SettingsItem";

interface SecuritySectionProps {
  activeSessionsCount: number;
  loadingSessions: boolean;
  loggingOutAll: boolean;
  onShowSessions: () => void;
  onLogoutAllDevices: () => void;
}

export const SecuritySection: React.FC<SecuritySectionProps> = ({
  activeSessionsCount,
  loadingSessions,
  loggingOutAll,
  onShowSessions,
  onLogoutAllDevices,
}) => {
  return (
    <SettingsSection
      title="Security"
      icon={Shield}
      description="Manage your account security and active sessions."
    >
      <SettingsItem
        label="Active Sessions"
        value=""
        action={loadingSessions ? "Loading..." : "View sessions"}
        onAction={onShowSessions}
        actionDisabled={loadingSessions}
        description={`View and manage all active sessions. ${activeSessionsCount > 0 ? `${activeSessionsCount} active session${activeSessionsCount === 1 ? "" : "s"}` : "No active sessions"}.`}
        loadingStates={{ sessions: loadingSessions }}
      />
      <SettingsItem
        label="Logout All Devices"
        value=""
        action={loggingOutAll ? "Logging out..." : "Logout everywhere"}
        onAction={onLogoutAllDevices}
        actionDisabled={loggingOutAll}
        actionIcon={LogOut}
        actionVariant="danger"
        description="Sign out from all devices and browsers. You will need to login again."
        loadingStates={{ logoutAll: loggingOutAll }}
      />
    </SettingsSection>
  );
};
