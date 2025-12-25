import React from "react";
import { User } from "lucide-react";
import { SettingsSection } from "../components/SettingsSection";
import { SettingsItem } from "../components/SettingsItem";

interface ProfileSectionProps {
  userName?: string;
  userEmail?: string;
}

export const ProfileSection: React.FC<ProfileSectionProps> = ({
  userName,
  userEmail,
}) => {
  return (
    <SettingsSection
      title="Profile"
      icon={User}
      description="Personal information that appears on shared items."
    >
      <SettingsItem label="Full Name" value={userName || ""} />
      <SettingsItem label="Email" value={userEmail || ""} />
    </SettingsSection>
  );
};
