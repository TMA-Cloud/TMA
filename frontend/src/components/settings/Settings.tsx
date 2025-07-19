import React from "react";
import { useTheme } from "../../contexts/ThemeContext";
import { useAuth } from "../../contexts/AuthContext";
import { useStorageUsage } from "../../hooks/useStorageUsage";
import { User, HardDrive } from "lucide-react";
import { useState } from "react";
import { ToastContainer, Toast } from "../ui/Toast";

export const Settings: React.FC = () => {
  const { theme, toggleTheme } = useTheme();
  const { user } = useAuth();
  const { usage, loading } = useStorageUsage();
  const [showThemeToast, setShowThemeToast] = useState(false);

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  const handleThemeToggle = () => {
    toggleTheme();
    setShowThemeToast(true);
    setTimeout(() => setShowThemeToast(false), 2000);
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
              : `${formatBytes(usage.used)} of ${formatBytes(usage.total)}`,
        },
        {
          label: "Available Space",
          value: loading || !usage ? "Loading..." : formatBytes(usage.free),
        },
      ],
    },
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

      {/* Theme Toggle */}
      <div className="bg-white dark:bg-gray-800 rounded-xl p-6 border border-gray-200 dark:border-gray-700 mb-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Appearance
        </h3>
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium text-gray-900 dark:text-gray-100">
              Dark Mode
            </p>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Toggle between light and dark themes
            </p>
          </div>
          <button
            onClick={handleThemeToggle}
            className={`
              relative inline-flex h-6 w-11 items-center rounded-full transition-colors
              ${theme === "dark" ? "bg-blue-500" : "bg-gray-200"}
            `}
            aria-label="Toggle dark mode"
          >
            <span
              className={`
                inline-block h-4 w-4 transform rounded-full bg-white transition-transform duration-300
                ${theme === "dark" ? "translate-x-6" : "translate-x-1"}
              `}
            />
          </button>
        </div>
        {showThemeToast && (
          <div className="mt-4">
            <Toast
              id="theme-toast"
              message={`Switched to ${theme === "dark" ? "Dark" : "Light"} Mode`}
              type="success"
              onClose={() => setShowThemeToast(false)}
            />
          </div>
        )}
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
                      <button
                        className={`
                          relative inline-flex h-6 w-11 items-center rounded-full transition-colors
                          ${item.value ? "bg-blue-500" : "bg-gray-200 dark:bg-gray-600"}
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
                    ) : "action" in item && item.action !== undefined ? (
                      <button className="px-3 py-1 text-sm bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors duration-200">
                        {item.action}
                      </button>
                    ) : (
                      typeof item.value === "string" ||
                      (typeof item.value === "number" && (
                        <span className="text-gray-500 dark:text-gray-400">
                          {item.value}
                        </span>
                      ))
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <ToastContainer toasts={[]} onClose={() => {}} />
    </div>
  );
};
