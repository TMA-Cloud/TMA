import React, { useState, useEffect } from "react";
import { useAuth } from "../../contexts/AuthContext";
import { useStorageUsage } from "../../hooks/useStorageUsage";
import { User, HardDrive, Settings as SettingsIcon } from "lucide-react";
import { formatFileSize } from "../../utils/fileUtils";
import { getSignupStatus, toggleSignup, fetchAllUsers } from "../../utils/api";
import type { UserSummary } from "../../utils/api";
import { useToast } from "../../hooks/useToast";
import { Modal } from "../ui/Modal";

export const Settings: React.FC = () => {
  const { user } = useAuth();
  const { usage, loading } = useStorageUsage();
  const { showToast } = useToast();
  const [signupEnabled, setSignupEnabled] = useState(false);
  const [canToggleSignup, setCanToggleSignup] = useState(false);
  const [totalUsers, setTotalUsers] = useState<number | null>(null);
  const [additionalUsers, setAdditionalUsers] = useState<number | null>(null);
  const [loadingSignupStatus, setLoadingSignupStatus] = useState(true);
  const [togglingSignup, setTogglingSignup] = useState(false);
  const [usersModalOpen, setUsersModalOpen] = useState(false);
  const [usersList, setUsersList] = useState<UserSummary[]>([]);
  const [loadingUsersList, setLoadingUsersList] = useState(false);
  const [usersListError, setUsersListError] = useState<string | null>(null);

  useEffect(() => {
    loadSignupStatus();
  }, []);

  const loadSignupStatus = async () => {
    try {
      setLoadingSignupStatus(true);
      const status = await getSignupStatus();
      setSignupEnabled(status.signupEnabled);
      setCanToggleSignup(status.canToggle);
      setTotalUsers(
        typeof status.totalUsers === "number" ? status.totalUsers : null,
      );
      setAdditionalUsers(
        typeof status.additionalUsers === "number"
          ? status.additionalUsers
          : null,
      );
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

  const loadUsersList = async () => {
    try {
      setLoadingUsersList(true);
      setUsersListError(null);
      const { users } = await fetchAllUsers();
      setUsersList(users);
      setTotalUsers(users.length);
      setAdditionalUsers(Math.max(users.length - 1, 0));
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

  const handleCloseUsersModal = () => {
    setUsersModalOpen(false);
  };

  const formatSignupDate = (isoString: string) => {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) {
      return "Unknown";
    }
    return date.toLocaleString();
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
                label: "Other Registered Users",
                value: loadingSignupStatus
                  ? "Loading..."
                  : additionalUsers === null
                    ? "Unavailable"
                    : additionalUsers === 0
                      ? "No other users yet"
                      : `${additionalUsers} ${
                          additionalUsers === 1 ? "user" : "users"
                        }`,
              },
              {
                label: "Total Users (including you)",
                value: loadingSignupStatus
                  ? "Loading..."
                  : totalUsers === null
                    ? "Unavailable"
                    : totalUsers.toString(),
              },
              {
                label: "Registered Users",
                value: "",
                action: loadingUsersList ? "Loading..." : "Show all users",
                onAction: handleShowUsers,
                actionDisabled: loadingUsersList,
                description: "Review every account currently registered",
              },
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
                      <div className="flex flex-col items-end">
                        <button
                          onClick={
                            "onAction" in item &&
                            typeof item.onAction === "function"
                              ? item.onAction
                              : undefined
                          }
                          disabled={
                            ("actionDisabled" in item &&
                              item.actionDisabled === true) ||
                            !(
                              "onAction" in item &&
                              typeof item.onAction === "function"
                            )
                          }
                          className={`
                            px-3 py-1 text-sm rounded-lg transition-colors duration-200
                            ${
                              ("actionDisabled" in item &&
                                item.actionDisabled === true) ||
                              !(
                                "onAction" in item &&
                                typeof item.onAction === "function"
                              )
                                ? "bg-gray-300 dark:bg-gray-600 cursor-not-allowed opacity-70"
                                : "bg-blue-500 hover:bg-blue-600 text-white"
                            }
                          `}
                        >
                          {item.action}
                        </button>
                        {"description" in item && item.description && (
                          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1 max-w-[200px] text-right">
                            {item.description}
                          </p>
                        )}
                      </div>
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

      <Modal
        isOpen={usersModalOpen}
        onClose={handleCloseUsersModal}
        title="All Registered Users"
        size="lg"
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-600 dark:text-gray-300">
              {usersList.length > 0
                ? `${usersList.length} user${usersList.length === 1 ? "" : "s"} total`
                : "No users to display yet"}
            </p>
            <button
              onClick={loadUsersList}
              disabled={loadingUsersList}
              className={`
                px-3 py-1 text-sm rounded-lg transition-colors duration-200 border
                ${
                  loadingUsersList
                    ? "border-gray-300 dark:border-gray-600 text-gray-400 cursor-not-allowed"
                    : "border-blue-500 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20"
                }
              `}
            >
              {loadingUsersList ? "Refreshing..." : "Refresh"}
            </button>
          </div>

          {usersListError && (
            <p className="text-sm text-red-500 dark:text-red-400">
              {usersListError}
            </p>
          )}

          {loadingUsersList ? (
            <p className="text-center text-gray-600 dark:text-gray-300">
              Loading users...
            </p>
          ) : usersList.length === 0 ? (
            <p className="text-center text-gray-600 dark:text-gray-300">
              Once people sign up, their accounts will appear here.
            </p>
          ) : (
            <div className="overflow-x-auto max-h-[60vh]">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="text-left text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700">
                    <th className="py-2 pr-4 font-medium">Name</th>
                    <th className="py-2 pr-4 font-medium">Email</th>
                    <th className="py-2 font-medium">Joined</th>
                  </tr>
                </thead>
                <tbody>
                  {usersList.map((listedUser) => (
                    <tr
                      key={listedUser.id}
                      className="border-b border-gray-100 dark:border-gray-800 last:border-b-0"
                    >
                      <td className="py-2 pr-4 text-gray-900 dark:text-gray-100">
                        {listedUser.name || "Unnamed"}
                      </td>
                      <td className="py-2 pr-4 text-gray-700 dark:text-gray-300">
                        {listedUser.email}
                      </td>
                      <td className="py-2 text-gray-600 dark:text-gray-400">
                        {formatSignupDate(listedUser.createdAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Modal>
    </div>
  );
};
