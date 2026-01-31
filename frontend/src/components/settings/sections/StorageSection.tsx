import React from "react";
import { HardDrive } from "lucide-react";
import { SettingsSection } from "../components/SettingsSection";
import { SettingsItem } from "../components/SettingsItem";
import { formatFileSize } from "../../../utils/fileUtils";

interface StorageSectionProps {
  usage?: {
    used: number;
    total: number | null;
    free: number | null;
  };
  loading?: boolean;
}

export const StorageSection: React.FC<StorageSectionProps> = ({
  usage,
  loading,
}) => {
  const totalLabel =
    usage && usage.total !== null ? formatFileSize(usage.total) : "Unlimited";
  const availableLabel =
    usage && usage.free !== null ? formatFileSize(usage.free) : "Unlimited";

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
            : `${formatFileSize(usage.used)} of ${totalLabel}`
        }
      />
      <SettingsItem
        label="Available Space"
        value={loading || !usage ? "Loading..." : availableLabel}
      />
    </SettingsSection>
  );
};
