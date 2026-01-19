import React from "react";
import { RefreshCw } from "lucide-react";
import { SettingsSection } from "../components/SettingsSection";
import { SettingsItem } from "../components/SettingsItem";
import type { VersionInfo } from "../../../utils/api";

interface UpdatesSectionProps {
  versionStatusText: (key: keyof VersionInfo) => string;
  versionDescription: (key: keyof VersionInfo) => string;
  checkingVersions: boolean;
  versionError: string | null;
  onCheckVersions: () => void;
}

export const UpdatesSection: React.FC<UpdatesSectionProps> = ({
  versionStatusText,
  versionDescription,
  checkingVersions,
  versionError,
  onCheckVersions,
}) => {
  return (
    <SettingsSection
      title="Updates"
      icon={RefreshCw}
      description="Check whether this deployment is up to date."
    >
      <SettingsItem
        label="Frontend"
        value={versionStatusText("frontend")}
        description={versionDescription("frontend")}
      />
      <SettingsItem
        label="Backend"
        value={versionStatusText("backend")}
        description={versionDescription("backend")}
      />
      <SettingsItem
        label="Agent"
        value={versionStatusText("agent")}
        description={versionDescription("agent")}
      />
      <SettingsItem
        label="Check for Updates"
        value=""
        action={checkingVersions ? "Checking..." : "Check now"}
        onAction={onCheckVersions}
        actionDisabled={checkingVersions}
        description={
          versionError ?? "Fetches latest version tags from tma-cloud.github.io"
        }
      />
    </SettingsSection>
  );
};
