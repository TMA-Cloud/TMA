import React from "react";
import { HardDrive } from "lucide-react";
import { SettingsSection } from "../components/SettingsSection";
import { SettingsItem } from "../components/SettingsItem";
import { formatFileSize } from "../../../utils/fileUtils";

interface StorageSectionProps {
  usage?: {
    used: number;
    total: number;
    free: number;
  };
  loading?: boolean;
}

export const StorageSection: React.FC<StorageSectionProps> = ({
  usage,
  loading,
}) => {
  return (
    <SettingsSection
      title="Storage"
      icon={HardDrive}
      description="Track how your allocated drive space is being used."
    >
      <SettingsItem
        label="Used Space"
        value={
          loading || !usage
            ? "Loading..."
            : `${formatFileSize(usage.used)} of ${formatFileSize(usage.total)}`
        }
      />
      <SettingsItem
        label="Available Space"
        value={loading || !usage ? "Loading..." : formatFileSize(usage.free)}
      />
    </SettingsSection>
  );
};
