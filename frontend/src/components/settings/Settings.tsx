import React, { useState, useEffect } from "react";
import { useAuth } from "../../contexts/AuthContext";
import { useStorageUsage } from "../../hooks/useStorageUsage";
import {
  User,
  HardDrive,
  Settings as SettingsIcon,
  ChevronRight,
  Loader2,
} from "lucide-react";
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
  const storageUsagePercent =
    usage && usage.total > 0
      ? Math.min(100, Math.round((usage.used / usage.total) * 100))
      : null;

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
      description: "Personal information that appears on shared items.",
      items: [
        { label: "Full Name", value: user?.name || "" },
        { label: "Email", value: user?.email || "" },
      ],
    },
    {
      title: "Storage",
      icon: HardDrive,
      description: "Track how your allocated drive space is being used.",
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
            description: "Manage workspace access, visibility, and onboarding.",
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
    <div className="p-6 md:p-8 space-y-8 bg-gradient-to-b from-gray-50/60 to-white dark:from-gray-900/40 dark:to-gray-950/60 rounded-3xl">
      {/* Hero / Header */}
      <div
        className="relative overflow-hidden border border-gray-200/70 dark:border-gray-800/70 rounded-2xl bg-white/80 dark:bg-gray-900/70 shadow-sm"
        style={{ animation: "fadeIn 0.45s ease both" }}
      >
        <div className="absolute inset-0 bg-gradient-to-r from-blue-500/10 via-transparent to-purple-500/10" />
        <div className="absolute -top-10 -right-10 w-40 h-40 bg-blue-500/20 blur-3xl pointer-events-none" />
        <div className="relative flex flex-col gap-6 p-6 md:flex-row md:items-center md:justify-between">
          <div className="space-y-2">
            <p className="uppercase tracking-[0.35em] text-xs font-semibold text-blue-500">
              Control Center
            </p>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">
              Settings
            </h1>
            <p className="text-gray-600 dark:text-gray-400 max-w-2xl">
              Manage your account preferences and smoothly adjust application
              controls without leaving this page.
            </p>
            {user?.name && (
              <div className="inline-flex items-center gap-2 mt-3 px-3 py-1.5 rounded-full bg-blue-500/10 text-sm text-blue-700 dark:text-blue-200 border border-blue-500/20">
                <User className="w-4 h-4" />
                <span>Signed in as {user.name}</span>
              </div>
            )}
          </div>

          <div className="w-full md:w-1/2 space-y-3">
            <div className="flex items-center justify-between text-sm text-gray-600 dark:text-gray-400">
              <span>Storage usage</span>
              <span>
                {storageUsagePercent !== null
                  ? `${storageUsagePercent}%`
                  : "Loading..."}
              </span>
            </div>
            <div className="h-2 w-full rounded-full bg-gray-200/70 dark:bg-gray-800/60 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-blue-500 via-indigo-500 to-purple-500 transition-[width] duration-500"
                style={{
                  width:
                    storageUsagePercent !== null
                      ? `${storageUsagePercent}%`
                      : "0%",
                }}
              />
            </div>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              {loading || !usage
                ? "Calculating storage details..."
                : `${formatFileSize(usage.used)} used · ${formatFileSize(usage.free)} free of ${formatFileSize(usage.total)}`}
            </p>
          </div>
        </div>
      </div>

      {/* Settings Sections */}
      <div className="space-y-8">
        {settingsSections.map((section, index) => {
          const Icon = section.icon;

          return (
            <div
              key={index}
              className="relative overflow-hidden bg-white/90 dark:bg-gray-900/70 rounded-2xl p-6 border border-gray-200/70 dark:border-gray-800/70 shadow-sm hover:shadow-lg transition-shadow duration-300"
              style={{
                animation: "slideUp 0.45s cubic-bezier(0.16, 1, 0.3, 1) both",
                animationDelay: `${index * 80}ms`,
              }}
            >
              <div className="absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-blue-500/40 to-transparent" />

              <div className="flex flex-wrap items-center gap-3 mb-6">
                <div className="p-3 rounded-2xl bg-blue-500/10 text-blue-600 dark:text-blue-300">
                  <Icon className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                    {section.title}
                  </h3>
                  {"description" in section && section.description && (
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      {section.description}
                    </p>
                  )}
                </div>
              </div>

              <div className="space-y-4">
                {section.items.map((item, itemIndex) => (
                  <div
                    key={itemIndex}
                    className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-2xl bg-gray-50/70 dark:bg-gray-900/60 px-4 py-3 border border-transparent hover:border-blue-500/40 transition-all duration-200"
                  >
                    <div>
                      <p className="font-medium text-gray-900 dark:text-gray-100">
                        {item.label}
                      </p>
                      {"description" in item && item.description && (
                        <p className="text-sm text-gray-500 dark:text-gray-400">
                          {item.description}
                        </p>
                      )}
                    </div>

                    {"toggle" in item && item.toggle !== undefined ? (
                      <div className="flex flex-col items-end">
                        <button
                          onClick={handleToggleSignup}
                          disabled={togglingSignup || loadingSignupStatus}
                          className={`
                            relative inline-flex h-6 w-12 items-center rounded-full transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500
                            ${item.value ? "bg-gradient-to-r from-blue-500 to-indigo-500" : "bg-gray-200 dark:bg-gray-700"}
                            ${togglingSignup || loadingSignupStatus ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}
                          `}
                          aria-label={item.label}
                        >
                          <span
                            className={`
                              inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform duration-300
                              ${item.value ? "translate-x-7" : "translate-x-1"}
                            `}
                          />
                        </button>
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
                            inline-flex items-center gap-2 px-4 py-2 text-sm rounded-2xl transition-all duration-200 border
                            ${
                              ("actionDisabled" in item &&
                                item.actionDisabled === true) ||
                              !(
                                "onAction" in item &&
                                typeof item.onAction === "function"
                              )
                                ? "bg-gray-200 dark:bg-gray-700 cursor-not-allowed opacity-70 border-transparent"
                                : "border-blue-500/40 text-blue-600 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/30"
                            }
                          `}
                        >
                          {item.label === "Registered Users" &&
                          loadingUsersList ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <ChevronRight className="w-4 h-4" />
                          )}
                          <span>{item.action}</span>
                        </button>
                      </div>
                    ) : (
                      <span className="text-base font-semibold text-gray-700 dark:text-gray-200 text-right">
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
            <p className="text-center text-gray-600 dark:text-gray-300 flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
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
                      className="border-b border-gray-100 dark:border-gray-800 last:border-b-0 hover:bg-gray-50/60 dark:hover:bg-gray-900/40 transition-colors"
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
