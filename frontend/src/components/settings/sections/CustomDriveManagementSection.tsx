import React, { useState, useEffect, useCallback } from "react";
import {
  Shield,
  Loader2,
  AlertCircle,
  CheckCircle2,
  X,
  Plus,
  Server,
  RefreshCw,
  Eye,
  EyeOff,
} from "lucide-react";
import { SettingsSection } from "../components/SettingsSection";
import type { UserCustomDriveInfo } from "../../../utils/api";
import {
  getAgentConfig,
  updateAgentConfig,
  getAgentPaths,
} from "../../../utils/api";
import type { UserCustomDriveLocalState } from "../hooks/useCustomDriveManagement";
import { useToast } from "../../../hooks/useToast";
import { getErrorMessage } from "../../../utils/errorUtils";

interface CustomDriveManagementSectionProps {
  allUsersCustomDrive: UserCustomDriveInfo[];
  loadingAllUsersCustomDrive: boolean;
  updatingUserCustomDrive: string | null;
  userCustomDriveLocalState: UserCustomDriveLocalState;
  setUserCustomDriveLocalState: React.Dispatch<
    React.SetStateAction<UserCustomDriveLocalState>
  >;
  onConfirmEnable: (userId: string) => void;
  onConfirmDisable: (userId: string) => void;
  onUpdateUserCustomDrive: (
    userId: string,
    enabled: boolean,
    path: string | null,
    ignorePatterns?: string[],
  ) => Promise<boolean>;
  currentUserId?: string;
}

export const CustomDriveManagementSection: React.FC<
  CustomDriveManagementSectionProps
> = ({
  allUsersCustomDrive,
  loadingAllUsersCustomDrive,
  updatingUserCustomDrive,
  userCustomDriveLocalState,
  setUserCustomDriveLocalState,
  onConfirmEnable,
  onConfirmDisable,
  onUpdateUserCustomDrive,
  currentUserId,
}) => {
  const { showToast } = useToast();
  const [agentUrl, setAgentUrl] = useState("");
  const [agentToken, setAgentToken] = useState("");
  const [agentTokenSet, setAgentTokenSet] = useState(false);
  const [agentPaths, setAgentPaths] = useState<string[]>([]);
  const [loadingAgentPaths, setLoadingAgentPaths] = useState(false);
  const [loadingAgentConfig, setLoadingAgentConfig] = useState(true);
  const [savingAgentConfig, setSavingAgentConfig] = useState(false);
  const [showAgentToken, setShowAgentToken] = useState(false);
  const [agentConnected, setAgentConnected] = useState<boolean | null>(null);
  const [lastErrorTime, setLastErrorTime] = useState<number>(0);

  // Load agent config
  useEffect(() => {
    const loadAgentConfig = async () => {
      try {
        setLoadingAgentConfig(true);
        const config = await getAgentConfig();
        setAgentUrl(config.url || "");
        setAgentTokenSet(config.tokenSet);
        setAgentToken("");
      } catch {
        showToast("Failed to load agent configuration", "error");
      } finally {
        setLoadingAgentConfig(false);
      }
    };
    loadAgentConfig();
  }, [showToast]);

  // Load agent paths when URL is configured
  const loadAgentPaths = useCallback(
    async (showError = true, urlOverride?: string): Promise<boolean> => {
      const urlToUse = urlOverride || agentUrl;
      if (!urlToUse) {
        setAgentPaths([]);
        setAgentConnected(null);
        return false;
      }

      // Prevent spam: only show error if last error was more than 5 seconds ago
      const now = Date.now();
      const shouldShowError = showError && now - lastErrorTime > 5000;

      try {
        setLoadingAgentPaths(true);
        const response = await getAgentPaths();
        setAgentPaths(response.paths || []);
        setAgentConnected(true);
        setLastErrorTime(0); // Reset error time on success
        return true;
      } catch (error) {
        setAgentConnected(false);
        setLastErrorTime(now);
        setAgentPaths([]);
        // Only show error toast if enough time has passed
        if (shouldShowError) {
          showToast(getErrorMessage(error, "Agent connection failed"), "error");
        }
        return false;
      } finally {
        setLoadingAgentPaths(false);
      }
    },
    [agentUrl, showToast, lastErrorTime],
  );

  // Load paths only when user explicitly saves config or clicks refresh
  // No auto-loading to prevent spam

  const handleSaveAgentConfig = async () => {
    try {
      setSavingAgentConfig(true);
      // Reset connection status before saving
      setAgentConnected(null);
      setAgentPaths([]);

      const response = await updateAgentConfig(
        agentToken || null,
        agentUrl || null,
      );
      setAgentTokenSet(response.tokenSet);
      setAgentToken("");
      // Update URL from response to ensure consistency
      if (response.url !== null && response.url !== undefined) {
        setAgentUrl(response.url);
      } else {
        setAgentUrl("");
      }

      if (response.tokenSet && response.url) {
        // Configuration saved successfully - now verify connection using the saved URL
        const isConnected = await loadAgentPaths(false, response.url); // Don't show error toast here, we'll show our own
        if (isConnected) {
          showToast("Agent connected", "success");
        } else {
          // Backend validated but connection check failed (shouldn't happen, but handle it)
          showToast("Saved but connection unverified", "info");
        }
      } else {
        // Settings cleared
        showToast("Configuration cleared", "success");
        setAgentPaths([]);
        setAgentConnected(null);
      }
    } catch (error) {
      // Backend validation failed - don't save, show error
      const errorMessage = getErrorMessage(
        error,
        "Failed to save configuration",
      );
      showToast(errorMessage, "error");
      setAgentConnected(false);
      setAgentPaths([]);
    } finally {
      setSavingAgentConfig(false);
    }
  };

  // Sort users: current user first, then others
  const sortedUsers = React.useMemo(() => {
    if (!currentUserId) return allUsersCustomDrive;

    const currentUser = allUsersCustomDrive.find((u) => u.id === currentUserId);
    const otherUsers = allUsersCustomDrive.filter(
      (u) => u.id !== currentUserId,
    );

    return currentUser ? [currentUser, ...otherUsers] : allUsersCustomDrive;
  }, [allUsersCustomDrive, currentUserId]);

  return (
    <SettingsSection
      title="Custom Drive Management"
      icon={Shield}
      description="Manage custom drive settings for all users (Admin only)."
    >
      {/* Agent Configuration */}
      <div className="mb-6 p-4 bg-gray-50 dark:bg-gray-900/50 rounded-lg border border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-2 mb-4">
          <Server className="w-5 h-5 text-blue-600 dark:text-blue-400" />
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            Drive Agent Configuration
          </h3>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          Configure the agent URL and token. Paths must be added via the agent
          CLI first.
        </p>
        <form autoComplete="off" onSubmit={(e) => e.preventDefault()}>
          {/* Hidden dummy fields to distract password managers */}
          <input
            type="text"
            name="username"
            autoComplete="username"
            style={{
              position: "absolute",
              left: "-9999px",
              opacity: 0,
              pointerEvents: "none",
            }}
            tabIndex={-1}
            readOnly
          />
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            style={{
              position: "absolute",
              left: "-9999px",
              opacity: 0,
              pointerEvents: "none",
            }}
            tabIndex={-1}
            readOnly
          />
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Agent URL
              </label>
              <input
                type="text"
                name="x-agent-url-config"
                value={agentUrl}
                onChange={(e) => setAgentUrl(e.target.value)}
                placeholder="http://host.docker.internal:8080"
                disabled={loadingAgentConfig || savingAgentConfig}
                autoComplete="off"
                data-lpignore="true"
                data-1p-ignore="true"
                data-bwignore="true"
                data-form-type="other"
                role="textbox"
                inputMode="text"
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50"
              />
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                For Docker: Use http://host.docker.internal:8080 (Windows/Mac)
                or http://172.17.0.1:8080 (Linux). For local development:
                http://localhost:8080
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Agent Token
              </label>
              <div className="relative">
                <input
                  type="text"
                  name="x-agent-token-config"
                  value={
                    showAgentToken
                      ? agentToken
                      : "•".repeat(agentToken.length || 0)
                  }
                  onChange={(e) => {
                    if (showAgentToken) {
                      setAgentToken(e.target.value);
                    } else {
                      // When masked, show on first input
                      setShowAgentToken(true);
                      setAgentToken(e.target.value.replace(/•/g, ""));
                    }
                  }}
                  onFocus={() => {
                    if (!showAgentToken && agentToken) {
                      setShowAgentToken(true);
                    }
                  }}
                  placeholder={
                    agentTokenSet
                      ? "Leave empty to keep current token"
                      : "Enter token"
                  }
                  disabled={loadingAgentConfig || savingAgentConfig}
                  autoComplete="off"
                  data-lpignore="true"
                  data-1p-ignore="true"
                  data-bwignore="true"
                  data-form-type="other"
                  role="textbox"
                  inputMode="text"
                  className="w-full px-3 py-2 pr-10 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50 font-mono"
                />
                <button
                  type="button"
                  onClick={() => setShowAgentToken(!showAgentToken)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                  tabIndex={-1}
                  aria-label={
                    showAgentToken ? "Hide agent token" : "Show agent token"
                  }
                >
                  {showAgentToken ? (
                    <EyeOff className="h-5 w-5" />
                  ) : (
                    <Eye className="h-5 w-5" />
                  )}
                </button>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={handleSaveAgentConfig}
                disabled={loadingAgentConfig || savingAgentConfig}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {savingAgentConfig ? "Saving..." : "Save Agent Config"}
              </button>
              {agentUrl && agentTokenSet && (
                <button
                  onClick={() => loadAgentPaths(true)}
                  disabled={loadingAgentPaths}
                  className="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-50 flex items-center gap-2"
                >
                  <RefreshCw
                    className={`w-4 h-4 ${loadingAgentPaths ? "animate-spin" : ""}`}
                  />
                  Refresh Paths
                </button>
              )}
            </div>
            {agentUrl && agentTokenSet && (
              <div className="mt-2 flex items-center gap-2 text-sm">
                {agentConnected === true && (
                  <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>Agent connected</span>
                    {agentPaths.length > 0 && (
                      <span>• {agentPaths.length} path(s) available</span>
                    )}
                  </div>
                )}
                {agentConnected === false && (
                  <div className="flex items-center gap-2 text-red-600 dark:text-red-400">
                    <AlertCircle className="w-4 h-4" />
                    <span>Agent offline</span>
                  </div>
                )}
                {agentConnected === null && loadingAgentPaths && (
                  <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Checking agent connection...</span>
                  </div>
                )}
              </div>
            )}
            {!agentUrl && (
              <div className="mt-2 text-sm text-yellow-600 dark:text-yellow-400">
                Configure agent URL and token to see available paths
              </div>
            )}
          </div>
        </form>
      </div>

      <div className="space-y-4">
        {loadingAllUsersCustomDrive ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
            <span className="ml-2 text-gray-600 dark:text-gray-400">
              Loading users' custom drive settings...
            </span>
          </div>
        ) : sortedUsers.length === 0 ? (
          <div className="text-center py-8 text-gray-500 dark:text-gray-400">
            No users found
          </div>
        ) : (
          <div className="space-y-4">
            {sortedUsers.map((userInfo) => {
              const isCurrentUser = currentUserId === userInfo.id;
              const isUpdating = updatingUserCustomDrive === userInfo.id;
              const localState = userCustomDriveLocalState[userInfo.id] || {
                enabled: userInfo.customDrive.enabled,
                path: userInfo.customDrive.path || "",
                ignorePatterns: userInfo.customDrive.ignorePatterns || [],
                expanded: false,
                editingIgnorePatterns: false,
                newPattern: "",
                error: null,
                originalPath: userInfo.customDrive.path || "",
                originalIgnorePatterns: [
                  ...(userInfo.customDrive.ignorePatterns || []),
                ],
              };

              // Calculate if there are changes
              const originalPath =
                localState.originalPath ?? userInfo.customDrive.path ?? "";
              const originalIgnorePatterns =
                localState.originalIgnorePatterns ??
                userInfo.customDrive.ignorePatterns ??
                [];
              const pathChanged =
                localState.expanded &&
                localState.path.trim() !== originalPath.trim();
              const patternsChanged =
                JSON.stringify([...localState.ignorePatterns].sort()) !==
                JSON.stringify([...originalIgnorePatterns].sort());
              const hasChanges = pathChanged || patternsChanged;

              return (
                <div
                  key={userInfo.id}
                  className={`stagger-item hover-lift border rounded-lg p-4 space-y-3 ${
                    isCurrentUser
                      ? "border-green-500/50 dark:border-green-500/50 bg-green-50/30 dark:bg-green-900/10"
                      : "border-gray-200 dark:border-gray-700"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        {isCurrentUser && (
                          <div className="flex items-center gap-1.5">
                            <div className="w-3 h-3 rounded-full bg-green-500 flex-shrink-0 shadow-sm"></div>
                            <span className="text-xs font-semibold text-green-600 dark:text-green-400 px-2 py-0.5 bg-green-100 dark:bg-green-900/30 rounded">
                              You
                            </span>
                          </div>
                        )}
                        <h4 className="font-medium text-gray-900 dark:text-gray-100">
                          {userInfo.name || userInfo.email}
                        </h4>
                      </div>
                      <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                        {userInfo.email}
                      </p>
                      {localState.enabled &&
                        localState.path &&
                        !localState.expanded && (
                          <p className="text-xs text-gray-600 dark:text-gray-400 mt-2 font-mono bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded inline-block">
                            {localState.path}
                          </p>
                        )}
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={userInfo.customDrive.enabled}
                        onChange={(e) => {
                          const newValue = e.target.checked;
                          if (newValue) {
                            onConfirmEnable(userInfo.id);
                          } else {
                            onConfirmDisable(userInfo.id);
                          }
                        }}
                        disabled={isUpdating || localState.expanded}
                        className="sr-only peer"
                      />
                      <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-300 dark:peer-focus:ring-blue-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-blue-600"></div>
                    </label>
                  </div>

                  {/* Show ignore patterns when custom drive is enabled (even if not expanded) */}
                  {userInfo.customDrive.enabled &&
                    !localState.expanded &&
                    !localState.editingIgnorePatterns && (
                      <div className="space-y-2 pt-3 border-t border-gray-200 dark:border-gray-700">
                        <div className="flex items-center justify-between">
                          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                            Ignore Patterns
                          </label>
                          <button
                            onClick={() => {
                              setUserCustomDriveLocalState((prev) => ({
                                ...prev,
                                [userInfo.id]: {
                                  enabled: userInfo.customDrive.enabled,
                                  path: userInfo.customDrive.path || "",
                                  ignorePatterns:
                                    userInfo.customDrive.ignorePatterns || [],
                                  expanded: false,
                                  editingIgnorePatterns: true,
                                  newPattern: "",
                                  error: null,
                                  originalPath: userInfo.customDrive.path || "",
                                  originalIgnorePatterns: [
                                    ...(userInfo.customDrive.ignorePatterns ||
                                      []),
                                  ],
                                },
                              }));
                            }}
                            disabled={isUpdating}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-xl transition-all duration-200 border border-blue-500/40 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            <span>Edit</span>
                          </button>
                        </div>
                        {userInfo.customDrive.ignorePatterns &&
                        userInfo.customDrive.ignorePatterns.length > 0 ? (
                          <div className="flex flex-wrap gap-2 mt-2">
                            {userInfo.customDrive.ignorePatterns.map(
                              (pattern, index) => (
                                <span
                                  key={index}
                                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-mono rounded-xl bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-700"
                                >
                                  {pattern}
                                </span>
                              ),
                            )}
                          </div>
                        ) : (
                          <p className="text-xs text-gray-500 dark:text-gray-400 italic">
                            No ignore patterns configured
                          </p>
                        )}
                      </div>
                    )}

                  {/* Show ignore patterns editor when editing (even if not in full expanded mode) */}
                  {(localState.expanded ||
                    localState.editingIgnorePatterns) && (
                    <div className="space-y-4 pt-3 border-t border-gray-200 dark:border-gray-700 animate-fadeIn">
                      {localState.expanded && (
                        <div>
                          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                            Custom Drive Path
                          </label>
                          {agentPaths.length > 0 ? (
                            <select
                              value={localState.path}
                              onChange={(e) => {
                                setUserCustomDriveLocalState((prev) => ({
                                  ...prev,
                                  [userInfo.id]: {
                                    enabled:
                                      prev[userInfo.id]?.enabled || false,
                                    path: e.target.value,
                                    ignorePatterns:
                                      prev[userInfo.id]?.ignorePatterns || [],
                                    expanded:
                                      prev[userInfo.id]?.expanded || false,
                                    editingIgnorePatterns:
                                      prev[userInfo.id]
                                        ?.editingIgnorePatterns || false,
                                    error: null,
                                  },
                                }));
                              }}
                              disabled={isUpdating || loadingAgentPaths}
                              className={`w-full px-4 py-3 border-2 rounded-xl shadow-sm focus:outline-none focus:ring-2 dark:bg-gray-800/80 dark:text-white transition-all duration-200 ${
                                localState.error
                                  ? "border-red-500 focus:ring-red-500 focus:border-red-500"
                                  : "border-gray-300 dark:border-gray-600 focus:ring-blue-500 focus:border-blue-500"
                              }`}
                            >
                              <option value="">
                                Select a path from agent...
                              </option>
                              {agentPaths.map((path) => (
                                <option key={path} value={path}>
                                  {path}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <div className="space-y-2">
                              <input
                                type="text"
                                value={localState.path}
                                onChange={(e) => {
                                  setUserCustomDriveLocalState((prev) => ({
                                    ...prev,
                                    [userInfo.id]: {
                                      enabled:
                                        prev[userInfo.id]?.enabled || false,
                                      path: e.target.value,
                                      ignorePatterns:
                                        prev[userInfo.id]?.ignorePatterns || [],
                                      expanded:
                                        prev[userInfo.id]?.expanded || false,
                                      editingIgnorePatterns:
                                        prev[userInfo.id]
                                          ?.editingIgnorePatterns || false,
                                      error: null,
                                    },
                                  }));
                                }}
                                placeholder="No paths available from agent. Add paths via: tma-agent add --path <path>"
                                disabled={isUpdating}
                                className={`w-full px-4 py-3 border-2 rounded-xl shadow-sm focus:outline-none focus:ring-2 dark:bg-gray-800/80 dark:text-white transition-all duration-200 ${
                                  localState.error
                                    ? "border-red-500 focus:ring-red-500 focus:border-red-500"
                                    : "border-gray-300 dark:border-gray-600 focus:ring-blue-500 focus:border-blue-500"
                                }`}
                              />
                              <p className="text-xs text-gray-500 dark:text-gray-400">
                                Configure agent URL and token above, or add
                                paths via CLI:{" "}
                                <code className="bg-gray-100 dark:bg-gray-800 px-1 rounded">
                                  tma-agent add --path &lt;path&gt;
                                </code>
                              </p>
                            </div>
                          )}
                        </div>
                      )}

                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                            Ignore Patterns
                          </label>
                          <span className="text-xs text-gray-500 dark:text-gray-400">
                            {localState.ignorePatterns.length} pattern
                            {localState.ignorePatterns.length !== 1 ? "s" : ""}
                          </span>
                        </div>

                        {/* Display existing patterns as removable tags */}
                        {localState.ignorePatterns.length > 0 && (
                          <div className="flex flex-wrap gap-2 p-3 rounded-xl bg-gray-50/70 dark:bg-gray-900/60 border border-gray-200 dark:border-gray-700">
                            {localState.ignorePatterns.map((pattern, index) => (
                              <span
                                key={index}
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono rounded-xl bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border border-gray-300 dark:border-gray-600 shadow-sm"
                              >
                                {pattern}
                                <button
                                  type="button"
                                  onClick={() => {
                                    const newPatterns =
                                      localState.ignorePatterns.filter(
                                        (_, i) => i !== index,
                                      );
                                    setUserCustomDriveLocalState((prev) => ({
                                      ...prev,
                                      [userInfo.id]: {
                                        enabled:
                                          prev[userInfo.id]?.enabled || false,
                                        path: prev[userInfo.id]?.path || "",
                                        ignorePatterns: newPatterns,
                                        expanded:
                                          prev[userInfo.id]?.expanded || false,
                                        editingIgnorePatterns:
                                          prev[userInfo.id]
                                            ?.editingIgnorePatterns || false,
                                        error: null,
                                      },
                                    }));
                                  }}
                                  disabled={isUpdating}
                                  className="ml-1 p-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                  aria-label={`Remove ${pattern}`}
                                >
                                  <X className="w-3 h-3 text-gray-500 dark:text-gray-400" />
                                </button>
                              </span>
                            ))}
                          </div>
                        )}

                        {/* Add new pattern input */}
                        <div className="flex gap-2">
                          <input
                            type="text"
                            value={localState.newPattern || ""}
                            onChange={(e) => {
                              setUserCustomDriveLocalState((prev) => {
                                const current = prev[userInfo.id];
                                if (!current) return prev;
                                return {
                                  ...prev,
                                  [userInfo.id]: {
                                    enabled: current.enabled,
                                    path: current.path,
                                    ignorePatterns: current.ignorePatterns,
                                    expanded: current.expanded,
                                    editingIgnorePatterns:
                                      current.editingIgnorePatterns,
                                    newPattern: e.target.value,
                                    error: current.error,
                                    originalPath: current.originalPath,
                                    originalIgnorePatterns:
                                      current.originalIgnorePatterns,
                                  },
                                };
                              });
                            }}
                            onKeyDown={(e) => {
                              if (
                                e.key === "Enter" &&
                                localState.newPattern?.trim()
                              ) {
                                e.preventDefault();
                                const trimmed = localState.newPattern.trim();
                                if (
                                  trimmed &&
                                  !localState.ignorePatterns.includes(trimmed)
                                ) {
                                  setUserCustomDriveLocalState((prev) => ({
                                    ...prev,
                                    [userInfo.id]: {
                                      enabled:
                                        prev[userInfo.id]?.enabled || false,
                                      path: prev[userInfo.id]?.path || "",
                                      ignorePatterns: [
                                        ...(prev[userInfo.id]?.ignorePatterns ||
                                          []),
                                        trimmed,
                                      ],
                                      expanded:
                                        prev[userInfo.id]?.expanded || false,
                                      editingIgnorePatterns:
                                        prev[userInfo.id]
                                          ?.editingIgnorePatterns || false,
                                      newPattern: "",
                                      error: null,
                                    },
                                  }));
                                }
                              }
                            }}
                            placeholder="Enter pattern (e.g., node_modules, .git)"
                            disabled={isUpdating}
                            className="flex-1 px-4 py-2.5 border-2 border-gray-300 dark:border-gray-600 rounded-xl shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-800/80 dark:text-white font-mono text-sm transition-all duration-200"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              if (localState.newPattern?.trim()) {
                                const trimmed = localState.newPattern.trim();
                                if (
                                  !localState.ignorePatterns.includes(trimmed)
                                ) {
                                  setUserCustomDriveLocalState((prev) => ({
                                    ...prev,
                                    [userInfo.id]: {
                                      enabled:
                                        prev[userInfo.id]?.enabled || false,
                                      path: prev[userInfo.id]?.path || "",
                                      ignorePatterns: [
                                        ...(prev[userInfo.id]?.ignorePatterns ||
                                          []),
                                        trimmed,
                                      ],
                                      expanded:
                                        prev[userInfo.id]?.expanded || false,
                                      editingIgnorePatterns:
                                        prev[userInfo.id]
                                          ?.editingIgnorePatterns || false,
                                      newPattern: "",
                                      error: null,
                                    },
                                  }));
                                }
                              }
                            }}
                            disabled={
                              isUpdating ||
                              !localState.newPattern?.trim() ||
                              localState.ignorePatterns.includes(
                                localState.newPattern?.trim() || "",
                              )
                            }
                            className="px-4 py-2.5 bg-gradient-to-r from-blue-500 to-indigo-500 text-white rounded-xl shadow-sm hover:from-blue-600 hover:to-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 flex items-center gap-1.5"
                          >
                            <Plus className="w-4 h-4" />
                            <span className="text-sm font-medium">Add</span>
                          </button>
                        </div>
                        <p className="text-xs text-gray-500 dark:text-gray-400">
                          Patterns match exactly by default. Use{" "}
                          <code className="px-1 py-0.5 bg-gray-200 dark:bg-gray-700 rounded">
                            *
                          </code>{" "}
                          for wildcards (e.g.,{" "}
                          <code className="px-1 py-0.5 bg-gray-200 dark:bg-gray-700 rounded">
                            .git*
                          </code>{" "}
                          matches{" "}
                          <code className="px-1 py-0.5 bg-gray-200 dark:bg-gray-700 rounded">
                            .git
                          </code>
                          ,{" "}
                          <code className="px-1 py-0.5 bg-gray-200 dark:bg-gray-700 rounded">
                            .gitignore
                          </code>
                          ). Press Enter or click Add to add a pattern.
                        </p>
                      </div>

                      {localState.error && (
                        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
                          <div className="flex items-start gap-2">
                            <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 mt-0.5 flex-shrink-0" />
                            <p className="text-sm text-red-700 dark:text-red-400">
                              {localState.error}
                            </p>
                          </div>
                        </div>
                      )}

                      <div className="flex items-center gap-3">
                        <button
                          onClick={async () => {
                            // If editing only ignore patterns (not in full expanded mode), don't require path
                            if (
                              localState.editingIgnorePatterns &&
                              !localState.expanded
                            ) {
                              // Just update ignore patterns, keep enabled and path as is
                              const success = await onUpdateUserCustomDrive(
                                userInfo.id,
                                userInfo.customDrive.enabled,
                                userInfo.customDrive.path,
                                localState.ignorePatterns,
                              );
                              if (success) {
                                setUserCustomDriveLocalState((prev) => ({
                                  ...prev,
                                  [userInfo.id]: {
                                    enabled: userInfo.customDrive.enabled,
                                    path: userInfo.customDrive.path || "",
                                    ignorePatterns: localState.ignorePatterns,
                                    expanded: false,
                                    editingIgnorePatterns: false,
                                    newPattern: "",
                                    error: null,
                                    originalPath:
                                      userInfo.customDrive.path || "",
                                    originalIgnorePatterns: [
                                      ...localState.ignorePatterns,
                                    ],
                                  },
                                }));
                              }
                              return;
                            }

                            // Full form validation (when expanded)
                            if (!localState.path.trim()) {
                              setUserCustomDriveLocalState((prev) => ({
                                ...prev,
                                [userInfo.id]: {
                                  enabled: prev[userInfo.id]?.enabled || false,
                                  path: prev[userInfo.id]?.path || "",
                                  ignorePatterns:
                                    prev[userInfo.id]?.ignorePatterns || [],
                                  expanded:
                                    prev[userInfo.id]?.expanded || false,
                                  editingIgnorePatterns:
                                    prev[userInfo.id]?.editingIgnorePatterns ||
                                    false,
                                  newPattern: "",
                                  error: "Path is required",
                                  originalPath: prev[userInfo.id]?.originalPath,
                                  originalIgnorePatterns:
                                    prev[userInfo.id]?.originalIgnorePatterns,
                                },
                              }));
                              return;
                            }
                            const success = await onUpdateUserCustomDrive(
                              userInfo.id,
                              true,
                              localState.path.trim(),
                              localState.ignorePatterns,
                            );
                            // Only update local state on success
                            if (success) {
                              setUserCustomDriveLocalState((prev) => ({
                                ...prev,
                                [userInfo.id]: {
                                  enabled: true,
                                  path: localState.path.trim(),
                                  ignorePatterns: localState.ignorePatterns,
                                  expanded: false,
                                  editingIgnorePatterns: false,
                                  newPattern: "",
                                  error: null,
                                  originalPath: localState.path.trim(),
                                  originalIgnorePatterns: [
                                    ...localState.ignorePatterns,
                                  ],
                                },
                              }));
                            }
                          }}
                          disabled={
                            isUpdating ||
                            !hasChanges ||
                            (localState.expanded && !localState.path.trim())
                          }
                          className="px-4 py-2.5 bg-gradient-to-r from-blue-500 to-indigo-500 text-white rounded-xl shadow-sm hover:from-blue-600 hover:to-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 font-medium flex items-center gap-2"
                        >
                          {isUpdating ? (
                            <>
                              <Loader2 className="w-4 h-4 animate-spin" />
                              <span>Saving...</span>
                            </>
                          ) : (
                            <>
                              <CheckCircle2 className="w-4 h-4" />
                              <span>Save</span>
                            </>
                          )}
                        </button>
                        <button
                          onClick={() => {
                            setUserCustomDriveLocalState((prev) => ({
                              ...prev,
                              [userInfo.id]: {
                                enabled: userInfo.customDrive.enabled,
                                path: userInfo.customDrive.path || "",
                                ignorePatterns:
                                  userInfo.customDrive.ignorePatterns || [],
                                expanded: false,
                                editingIgnorePatterns: false,
                                newPattern: "",
                                error: null,
                                originalPath: undefined,
                                originalIgnorePatterns: undefined,
                              },
                            }));
                          }}
                          disabled={isUpdating}
                          className="px-4 py-2.5 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-xl hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 font-medium"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </SettingsSection>
  );
};
