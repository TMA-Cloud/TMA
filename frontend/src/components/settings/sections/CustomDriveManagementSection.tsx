import React from "react";
import { Shield, Loader2, AlertCircle, CheckCircle2 } from "lucide-react";
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
}) => {
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
        ) : allUsersCustomDrive.length === 0 ? (
          <div className="text-center py-8 text-gray-500 dark:text-gray-400">
            No users found
          </div>
        ) : (
          <div className="space-y-4">
            {allUsersCustomDrive.map((userInfo) => {
              const isUpdating = updatingUserCustomDrive === userInfo.id;
              const localState = userCustomDriveLocalState[userInfo.id] || {
                enabled: userInfo.customDrive.enabled,
                path: userInfo.customDrive.path || "",
                expanded: false,
                error: null,
              };

              return (
                <div
                  key={userInfo.id}
                  className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <h4 className="font-medium text-gray-900 dark:text-gray-100">
                        {userInfo.name || userInfo.email}
                      </h4>
                      <p className="text-sm text-gray-500 dark:text-gray-400">
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

                  {localState.expanded && (
                    <div className="space-y-3 pt-3 border-t border-gray-200 dark:border-gray-700">
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
                                expanded: prev[userInfo.id]?.expanded || false,
                                error: null,
                              },
                            }));
                          }}
                          placeholder="/mnt/external_drive or C:\\MyDrive"
                          disabled={isUpdating}
                          className={`w-full px-3 py-2 border rounded-md shadow-sm focus:outline-none focus:ring-2 dark:bg-gray-700 dark:text-white ${
                            localState.error
                              ? "border-red-500 focus:ring-red-500 focus:border-red-500"
                              : "border-gray-300 focus:ring-blue-500 focus:border-blue-500 dark:border-gray-600"
                          }`}
                        />
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
                            if (!localState.path.trim()) {
                              setUserCustomDriveLocalState((prev) => ({
                                ...prev,
                                [userInfo.id]: {
                                  enabled: prev[userInfo.id]?.enabled || false,
                                  path: prev[userInfo.id]?.path || "",
                                  expanded:
                                    prev[userInfo.id]?.expanded || false,
                                  error: "Path is required",
                                },
                              }));
                              return;
                            }
                            const success = await onUpdateUserCustomDrive(
                              userInfo.id,
                              true,
                              localState.path.trim(),
                            );
                            // Only update local state on success
                            if (success) {
                              setUserCustomDriveLocalState((prev) => ({
                                ...prev,
                                [userInfo.id]: {
                                  enabled: true,
                                  path: localState.path.trim(),
                                  expanded: false,
                                  error: null,
                                },
                              }));
                            }
                          }}
                          disabled={isUpdating || !localState.path.trim()}
                          className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 transition-colors"
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
                                expanded: false,
                                error: null,
                              },
                            }));
                          }}
                          disabled={isUpdating}
                          className="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-md hover:bg-gray-300 dark:hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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
