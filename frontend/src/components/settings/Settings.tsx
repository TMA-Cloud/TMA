import React, { useState, useEffect, useCallback } from "react";
import { useAuth } from "../../contexts/AuthContext";
import { useStorageUsage } from "../../hooks/useStorageUsage";
import {
  User,
  HardDrive,
  Settings as SettingsIcon,
  ChevronRight,
  Loader2,
  RefreshCw,
  Shield,
  LogOut,
} from "lucide-react";
import { formatFileSize } from "../../utils/fileUtils";
import {
  getSignupStatus,
  toggleSignup,
  fetchAllUsers,
  getCurrentVersions,
  fetchLatestVersions,
  logoutAllDevices,
} from "../../utils/api";
import type { UserSummary, VersionInfo } from "../../utils/api";
import { useToast } from "../../hooks/useToast";
import { Modal } from "../ui/Modal";

export const Settings: React.FC = () => {
  const { user, logout } = useAuth();
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
  const [currentVersions, setCurrentVersions] = useState<VersionInfo | null>(
    null,
  );
  const [latestVersions, setLatestVersions] = useState<VersionInfo | null>(
    null,
  );
  const [checkingVersions, setCheckingVersions] = useState(false);
  const [versionChecked, setVersionChecked] = useState(false);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [loggingOutAll, setLoggingOutAll] = useState(false);
  const storageUsagePercent =
    usage && usage.total > 0
      ? Math.min(100, Math.round((usage.used / usage.total) * 100))
      : null;

  useEffect(() => {
    loadSignupStatus();
    loadCurrentVersions();
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

  const loadCurrentVersions = async () => {
    try {
      const versions = await getCurrentVersions();
      setCurrentVersions(versions);
    } catch (error) {
      console.error("Failed to load current versions:", error);
      setVersionError("Unable to load current version information");
    }
  };

  const handleCheckVersions = useCallback(async () => {
    if (checkingVersions) return;

    try {
      setCheckingVersions(true);
      setVersionError(null);

      // Always fetch fresh current versions to detect backend redeployments
      const [current, latest] = await Promise.all([
        getCurrentVersions(),
        fetchLatestVersions(),
      ]);

      setCurrentVersions(current);
      setLatestVersions(latest);
      setVersionChecked(true);

      const allUpToDate =
        current.frontend === latest.frontend &&
        current.backend === latest.backend;

      showToast(
        allUpToDate ? "All components are up to date" : "Updates are available",
        allUpToDate ? "success" : "info",
      );
    } catch (error) {
      console.error("Failed to check versions:", error);
      setVersionError("Unable to check for updates right now");
      showToast("Failed to check for updates", "error");
    } finally {
      setCheckingVersions(false);
    }
  }, [checkingVersions, showToast]);

  const handleCloseUsersModal = () => {
    setUsersModalOpen(false);
  };

  const handleLogoutAllDevices = async () => {
    if (loggingOutAll) return;

    try {
      setLoggingOutAll(true);
      await logoutAllDevices();
      showToast("Successfully logged out from all devices", "success");
    } catch (error) {
      console.error("Failed to logout from all devices:", error);
      showToast("Failed to logout from all devices", "error");
      // Don't return - still clear local session to avoid inconsistent state
      // (e.g., server may have processed the request before network error)
    } finally {
      setLoggingOutAll(false);
    }

    // Always clear local session to ensure consistent state
    // If server logout failed, user can simply log back in
    // If server logout succeeded (or partially succeeded), this ensures local state matches
    try {
      await logout();
    } catch (error) {
      console.error("Failed to clear local session:", error);
      // Redirect to login page manually if logout() fails
      window.location.href = "/";
    }
  };

  const formatSignupDate = (isoString: string) => {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) {
      return "Unknown";
    }
    return date.toLocaleString();
  };

  const versionStatusText = (key: keyof VersionInfo) => {
    const current = currentVersions?.[key];
    if (!current) {
      return "Loading current version...";
    }

    if (!versionChecked || !latestVersions) {
      return `Current v${current}`;
    }

    const latest = latestVersions[key];
    if (!latest) {
      return `Current v${current}`;
    }

    if (current === latest) {
      return `☑️ Up to date (v${current})`;
    }

    return `⚠️ Outdated (current v${current}, latest v${latest})`;
  };

  const versionDescription = (key: keyof VersionInfo) => {
    if (versionError) return versionError;
    if (checkingVersions && !versionChecked) return "Checking update feed...";
    if (latestVersions?.[key])
      return `Latest available: v${latestVersions[key]}`;
    return "Version reported by this installation.";
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
    {
      title: "Updates",
      icon: RefreshCw,
      description: "Check whether this deployment is up to date.",
      items: [
        {
          label: "Frontend",
          value: versionStatusText("frontend"),
          description: versionDescription("frontend"),
        },
        {
          label: "Backend",
          value: versionStatusText("backend"),
          description: versionDescription("backend"),
        },
        {
          label: "Check for Updates",
          value: "",
          action: checkingVersions ? "Checking..." : "Check now",
          onAction: handleCheckVersions,
          actionDisabled: checkingVersions,
          description:
            versionError ??
            "Fetches latest version tags from tma-cloud.github.io",
        },
      ],
    },
    {
      title: "Security",
      icon: Shield,
      description: "Manage your account security and active sessions.",
      items: [
        {
          label: "Logout All Devices",
          value: "",
          action: loggingOutAll ? "Logging out..." : "Logout everywhere",
          onAction: handleLogoutAllDevices,
          actionDisabled: loggingOutAll,
          actionIcon: LogOut,
          actionVariant: "danger" as const,
          description:
            "Sign out from all devices and browsers. You will need to login again.",
        },
      ],
    },
  ];

  return (
    <div className="p-6 md:p-8 space-y-8">
      {/* Hero / Header */}
      <div
        className="relative overflow-hidden card-premium hover-lift spacing-card"
        style={{ animation: "fadeIn 0.45s ease both" }}
      >
        <div className="relative flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
          <div className="space-y-3">
            <p className="uppercase tracking-[0.35em] text-xs font-semibold text-blue-500/80">
              Control Center
            </p>
            <h1 className="text-4xl md:text-5xl font-bold text-gray-900 dark:text-gray-100 tracking-tight">
              Settings
            </h1>
            <p className="text-base md:text-lg text-gray-600/80 dark:text-gray-400/80 max-w-2xl">
              Manage your account preferences and adjust application controls
            </p>
            {user?.name && (
              <div className="inline-flex items-center gap-2 mt-4 px-4 py-2 rounded-full bg-blue-50/80 dark:bg-blue-900/30 text-sm font-medium text-blue-700 dark:text-blue-200 border border-blue-200/50 dark:border-blue-800/50">
                <User className="w-4 h-4 icon-muted" />
                <span>Signed in as {user.name}</span>
              </div>
            )}
          </div>

          <div className="w-full md:w-1/2 space-y-3">
            <div className="flex items-center justify-between text-sm font-medium text-gray-700 dark:text-gray-300">
              <span>Storage usage</span>
              <span className="font-semibold">
                {storageUsagePercent !== null
                  ? `${storageUsagePercent}%`
                  : "Loading..."}
              </span>
            </div>
            <div className="relative h-4 w-full rounded-full bg-gray-200/80 dark:bg-gray-700/80 overflow-hidden border border-gray-300/50 dark:border-gray-600/50 shadow-inner">
              <div
                className="h-full rounded-full bg-gradient-to-r from-blue-500 via-indigo-500 to-purple-500 transition-[width] duration-300 shadow-sm"
                style={{
                  width:
                    storageUsagePercent !== null && storageUsagePercent > 0
                      ? `${Math.max(storageUsagePercent, 1)}%`
                      : "0%",
                }}
              />
            </div>
            <p className="text-xs text-gray-500/80 dark:text-gray-400/80">
              {loading || !usage
                ? "Calculating storage details..."
                : usage.used > 0
                  ? `${formatFileSize(usage.used)} used · ${formatFileSize(usage.free)} free of ${formatFileSize(usage.total)}`
                  : `${formatFileSize(usage.free)} free of ${formatFileSize(usage.total)}`}
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
              className="relative overflow-hidden card-premium hover-lift spacing-card"
              style={{
                animation: "slideUp 0.45s cubic-bezier(0.16, 1, 0.3, 1) both",
                animationDelay: `${index * 80}ms`,
              }}
            >
              <div className="flex flex-wrap items-center gap-4 mb-6">
                <div className="p-3 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-300">
                  <Icon className="w-5 h-5 icon-muted" />
                </div>
                <div>
                  <h3 className="text-xl md:text-2xl font-bold text-gray-900 dark:text-gray-100 tracking-tight mb-1">
                    {section.title}
                  </h3>
                  {"description" in section && section.description && (
                    <p className="text-sm text-gray-500/80 dark:text-gray-400/80">
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
                      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
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
                            relative inline-flex h-6 w-12 items-center rounded-full transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500
                            ${item.value ? "bg-gradient-to-r from-blue-500 to-indigo-500" : "bg-gray-200 dark:bg-gray-700"}
                            ${togglingSignup || loadingSignupStatus ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}
                          `}
                          aria-label={item.label}
                        >
                          <span
                            className={`
                              inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform duration-200
                              ${item.value ? "translate-x-7" : "translate-x-1"}
                            `}
                          />
                        </button>
                      </div>
                    ) : "action" in item && item.action !== undefined ? (
                      <div className="flex flex-col items-end">
                        {(() => {
                          const isDanger =
                            "actionVariant" in item &&
                            item.actionVariant === "danger";
                          const isDisabled =
                            ("actionDisabled" in item &&
                              item.actionDisabled === true) ||
                            !(
                              "onAction" in item &&
                              typeof item.onAction === "function"
                            );
                          const ActionIcon =
                            "actionIcon" in item && item.actionIcon
                              ? item.actionIcon
                              : ChevronRight;

                          return (
                            <button
                              onClick={
                                "onAction" in item &&
                                typeof item.onAction === "function"
                                  ? item.onAction
                                  : undefined
                              }
                              disabled={isDisabled}
                              className={`
                                inline-flex items-center gap-2 px-4 py-2 text-sm rounded-2xl transition-all duration-200 border
                                ${
                                  isDisabled
                                    ? "bg-gray-200 dark:bg-gray-700 cursor-not-allowed opacity-70 border-transparent"
                                    : isDanger
                                      ? "border-red-500/40 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30"
                                      : "border-blue-500/40 text-blue-600 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/30"
                                }
                              `}
                            >
                              {item.label === "Registered Users" &&
                              loadingUsersList ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : item.label === "Logout All Devices" &&
                                loggingOutAll ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                <ActionIcon className="w-4 h-4" />
                              )}
                              <span>{item.action}</span>
                            </button>
                          );
                        })()}
                      </div>
                    ) : (
                      <span className="text-base font-semibold text-gray-700 dark:text-gray-200 text-left sm:text-right break-words">
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
