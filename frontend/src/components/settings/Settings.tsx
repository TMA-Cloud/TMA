import React from "react";
import { useTheme } from "../../contexts/ThemeContext";
import { User, Bell, Shield, HardDrive } from "lucide-react";

export const Settings: React.FC = () => {
  const { theme, toggleTheme } = useTheme();

  const settingsSections = [
    {
      title: "Profile",
      icon: User,
      items: [
        { label: "Full Name", value: "John Doe" },
        { label: "Email", value: "john@example.com" },
      ],
    },
    {
      title: "Notifications",
      icon: Bell,
      items: [
        { label: "Email Notifications", toggle: true, value: true },
        { label: "Desktop Notifications", toggle: true, value: false },
        { label: "File Share Alerts", toggle: true, value: true },
      ],
    },
    {
      title: "Privacy & Security",
      icon: Shield,
      items: [
        { label: "Two-Factor Authentication", toggle: true, value: true },
        { label: "Login Alerts", toggle: true, value: true },
        { label: "Data Export", action: "Export" },
      ],
    },
    {
      title: "Storage",
      icon: HardDrive,
      items: [
        { label: "Used Space", value: "15 GB of 100 GB" },
        { label: "Auto-Delete Trash", toggle: true, value: true },
        { label: "Sync Settings", action: "Configure" },
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
      <div className="bg-white dark:bg-gray-800 rounded-xl p-6 border border-gray-200 dark:border-gray-700">
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
            onClick={toggleTheme}
            className={`
              relative inline-flex h-6 w-11 items-center rounded-full transition-colors
              ${theme === "dark" ? "bg-blue-500" : "bg-gray-200"}
            `}
          >
            <span
              className={`
                inline-block h-4 w-4 transform rounded-full bg-white transition-transform
                ${theme === "dark" ? "translate-x-6" : "translate-x-1"}
              `}
            />
          </button>
        </div>
      </div>

      {/* Settings Sections */}
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
                  className="flex items-center justify-between"
                >
                  <div>
                    <p className="font-medium text-gray-900 dark:text-gray-100">
                      {item.label}
                    </p>
                  </div>

                  <div>
                    {item.toggle ? (
                      <button
                        className={`
                          relative inline-flex h-6 w-11 items-center rounded-full transition-colors
                          ${item.value ? "bg-blue-500" : "bg-gray-200 dark:bg-gray-600"}
                        `}
                      >
                        <span
                          className={`
                            inline-block h-4 w-4 transform rounded-full bg-white transition-transform
                            ${item.value ? "translate-x-6" : "translate-x-1"}
                          `}
                        />
                      </button>
                    ) : item.action ? (
                      <button className="px-3 py-1 text-sm bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors duration-200">
                        {item.action}
                      </button>
                    ) : (
                      <span className="text-gray-500 dark:text-gray-400">
                        {item.value}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
};
