import React, { useState, useEffect } from "react";
import { useAuth } from "../../contexts/AuthContext";
import { useStorageUsage } from "../../hooks/useStorageUsage";
import { User, HardDrive, Settings as SettingsIcon } from "lucide-react";
import { formatFileSize } from "../../utils/fileUtils";
import { getSignupStatus, toggleSignup } from "../../utils/api";
import { useToast } from "../../hooks/useToast";

export const Settings: React.FC = () => {
  const { user } = useAuth();
  const { usage, loading } = useStorageUsage();
  const { showToast } = useToast();
  const [signupEnabled, setSignupEnabled] = useState(false);
  const [canToggleSignup, setCanToggleSignup] = useState(false);
  const [loadingSignupStatus, setLoadingSignupStatus] = useState(true);
  const [togglingSignup, setTogglingSignup] = useState(false);

  useEffect(() => {
    loadSignupStatus();
  }, []);

  const loadSignupStatus = async () => {
    try {
      setLoadingSignupStatus(true);
      const status = await getSignupStatus();
      setSignupEnabled(status.signupEnabled);
      setCanToggleSignup(status.canToggle);
    } catch (error) {
      console.error("Failed to load signup status:", error);
    } finally {
      setLoadingSignupStatus(false);
    }
  };

  const handleToggleSignup = async () => {
    if (!canToggleSignup || togglingSignup) return;

    try {
      setTogglingSignup(true);
      const newStatus = !signupEnabled;
      await toggleSignup(newStatus);
      setSignupEnabled(newStatus);
      showToast(
        newStatus ? "Signup enabled" : "Signup disabled",
        newStatus ? "success" : "info",
      );
    } catch (error) {
      console.error("Failed to toggle signup:", error);
      showToast("Failed to update signup setting", "error");
    } finally {
      setTogglingSignup(false);
    }
  };

  const settingsSections = [
    {
      title: "Profile",
      icon: User,
      items: [
        { label: "Full Name", value: user?.name || "" },
        { label: "Email", value: user?.email || "" },
      ],
    },
    {
      title: "Storage",
      icon: HardDrive,
      items: [
        {
          label: "Used Space",
          value:
            loading || !usage
              ? "Loading..."
              : `${formatFileSize(usage.used)} of ${formatFileSize(usage.total)}`,
        },
        {
          label: "Available Space",
          value: loading || !usage ? "Loading..." : formatFileSize(usage.free),
        },
      ],
    },
    ...(canToggleSignup
      ? [
          {
            title: "Administration",
            icon: SettingsIcon,
            items: [
              {
                label: "Allow User Signup",
                value: signupEnabled,
                toggle: true,
                description: "Enable or disable new user registration",
              },
            ],
          },
        ]
      : []),
  ];

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">
          Settings
        </h1>
        <p className="text-gray-600 dark:text-gray-400">
          Manage your account preferences and application settings.
        </p>
      </div>

      {/* Settings Sections */}
      <div className="space-y-8">
        {settingsSections.map((section, index) => {
          const Icon = section.icon;

          return (
            <div
              key={index}
              className="bg-white dark:bg-gray-800 rounded-xl p-6 border border-gray-200 dark:border-gray-700"
            >
              <div className="flex items-center space-x-2 mb-4">
                <Icon className="w-5 h-5 text-blue-500" />
                <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                  {section.title}
                </h3>
              </div>

              <div className="space-y-4">
                {section.items.map((item, itemIndex) => (
                  <div
                    key={itemIndex}
                    className="flex items-center justify-between border-b border-dashed border-gray-200 dark:border-gray-700 pb-2 mb-2 last:border-b-0 last:pb-0 last:mb-0"
                  >
                    <div>
                      <p className="font-medium text-gray-900 dark:text-gray-100">
                        {item.label}
                      </p>
                    </div>

                    {"toggle" in item && item.toggle !== undefined ? (
                      <div className="flex flex-col items-end">
                        <button
                          onClick={handleToggleSignup}
                          disabled={togglingSignup || loadingSignupStatus}
                          className={`
                            relative inline-flex h-6 w-11 items-center rounded-full transition-colors
                            ${item.value ? "bg-blue-500" : "bg-gray-200 dark:bg-gray-600"}
                            ${togglingSignup || loadingSignupStatus ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}
                          `}
                          aria-label={item.label}
                        >
                          <span
                            className={`
                              inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-300
                              ${item.value ? "translate-x-6" : "translate-x-1"}
                            `}
                          />
                        </button>
                        {"description" in item && item.description && (
                          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 max-w-[200px] text-right">
                            {item.description}
                          </p>
                        )}
                      </div>
                    ) : "action" in item && item.action !== undefined ? (
                      <button className="px-3 py-1 text-sm bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors duration-200">
                        {item.action}
                      </button>
                    ) : (
                      <span className="text-gray-500 dark:text-gray-400">
                        {item.value}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
