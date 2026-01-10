import React from "react";
import {
  Shield,
  Loader2,
  AlertCircle,
  CheckCircle2,
  X,
  Plus,
} from "lucide-react";
import { SettingsSection } from "../components/SettingsSection";
import type { UserCustomDriveInfo } from "../../../utils/api";
import type { UserCustomDriveLocalState } from "../hooks/useCustomDriveManagement";

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
                          <input
                            type="text"
                            value={localState.path}
                            onChange={(e) => {
                              setUserCustomDriveLocalState((prev) => ({
                                ...prev,
                                [userInfo.id]: {
                                  enabled: prev[userInfo.id]?.enabled || false,
                                  path: e.target.value,
                                  ignorePatterns:
                                    prev[userInfo.id]?.ignorePatterns || [],
                                  expanded:
                                    prev[userInfo.id]?.expanded || false,
                                  editingIgnorePatterns:
                                    prev[userInfo.id]?.editingIgnorePatterns ||
                                    false,
                                  error: null,
                                },
                              }));
                            }}
                            placeholder="/mnt/external_drive or C:\\MyDrive"
                            disabled={isUpdating}
                            className={`w-full px-4 py-3 border-2 rounded-xl shadow-sm focus:outline-none focus:ring-2 dark:bg-gray-800/80 dark:text-white transition-all duration-200 ${
                              localState.error
                                ? "border-red-500 focus:ring-red-500 focus:border-red-500"
                                : "border-gray-300 dark:border-gray-600 focus:ring-blue-500 focus:border-blue-500"
                            }`}
                          />
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
                              setUserCustomDriveLocalState((prev) => ({
                                ...prev,
                                [userInfo.id]: {
                                  ...prev[userInfo.id],
                                  newPattern: e.target.value,
                                },
                              }));
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
