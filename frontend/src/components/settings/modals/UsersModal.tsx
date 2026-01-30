import React, { useMemo, useState } from "react";
import {
  Loader2,
  Shield,
  ShieldCheck,
  HardDrive,
  Edit2,
  Check,
  X,
} from "lucide-react";
import { format } from "date-fns";
import { Modal } from "../../ui/Modal";
import { updateUserStorageLimit, type UserSummary } from "../../../utils/api";
import { useToast } from "../../../hooks/useToast";
import { formatFileSize } from "../../../utils/fileUtils";
import {
  bytesToNumberAndUnit,
  numberAndUnitToBytes,
  type StorageUnit,
} from "../../../utils/storageUtils";

export interface UsersModalProps {
  isOpen: boolean;
  onClose: () => void;
  usersList: UserSummary[];
  loadingUsersList: boolean;
  usersListError: string | null;
  onRefresh: () => void;
  onStorageUpdated?: () => void;
  currentUserId?: string;
}

/**
 * Format signup date using date-fns for consistent formatting
 * @param isoString - ISO date string
 * @returns Formatted date string or "Unknown" if invalid
 */
const formatSignupDate = (isoString: string) => {
  try {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) {
      return "Unknown";
    }
    return format(date, "MMM d, yyyy 'at' h:mm a");
  } catch {
    return "Unknown";
  }
};

export const UsersModal: React.FC<UsersModalProps> = ({
  isOpen,
  onClose,
  usersList,
  loadingUsersList,
  usersListError,
  onRefresh,
  onStorageUpdated,
  currentUserId,
}) => {
  const { showToast } = useToast();
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState<string>("");
  const [editUnit, setEditUnit] = useState<StorageUnit>("GB");
  const [updating, setUpdating] = useState<string | null>(null);

  const mfaStats = useMemo(() => {
    if (usersList.length === 0) {
      return { enabled: 0, disabled: 0, percentage: 0 };
    }
    const enabled = usersList.filter((u) => u.mfaEnabled).length;
    const disabled = usersList.length - enabled;
    const percentage = Math.round((enabled / usersList.length) * 100);
    return { enabled, disabled, percentage };
  }, [usersList]);

  const handleEditLimit = (user: UserSummary) => {
    const currentLimit = user.storageLimit;
    // Convert bytes to number and unit for editing
    // Ensure we convert to number in case it comes as string from API
    // Also handle edge cases where value might be 0, empty string, or invalid
    let limitAsNumber: number | null = null;
    if (currentLimit !== null && currentLimit !== undefined) {
      const num = Number(currentLimit);
      limitAsNumber = Number.isFinite(num) && num > 0 ? num : null;
    }
    const { number, unit } = bytesToNumberAndUnit(limitAsNumber);
    setEditValue(number);
    setEditUnit(unit);
    setEditingUserId(user.id);
  };

  const handleCancelEdit = () => {
    setEditingUserId(null);
    setEditValue("");
    setEditUnit("GB");
  };

  const handleNumberChange = (value: string) => {
    // Only allow numbers and decimal point
    // Remove any non-numeric characters except decimal point
    const sanitized = value.replace(/[^0-9.]/g, "");
    // Prevent multiple decimal points
    const parts = sanitized.split(".");
    const cleaned =
      parts.length > 2 ? parts[0] + "." + parts.slice(1).join("") : sanitized;
    // Limit to reasonable length
    setEditValue(cleaned.slice(0, 15));
  };

  const handleSaveLimit = async (userId: string) => {
    setUpdating(userId);
    try {
      const trimmed = editValue.trim();

      // If empty, set to null (use default/actual disk space)
      if (trimmed === "") {
        await updateUserStorageLimit(userId, null);
        showToast(
          "Storage limit reset to default (actual disk space)",
          "success",
        );
        setEditingUserId(null);
        setEditValue("");
        setEditUnit("GB");
        onRefresh();
        if (userId === currentUserId) onStorageUpdated?.();
        return;
      }

      // Validate and convert to bytes
      const bytes = numberAndUnitToBytes(trimmed, editUnit);
      if (bytes === null) {
        showToast(
          "Invalid storage limit. Please enter a positive number.",
          "error",
        );
        setUpdating(null);
        return;
      }

      // Additional validation: ensure bytes is within reasonable range
      if (bytes <= 0 || bytes > Number.MAX_SAFE_INTEGER) {
        showToast(
          "Storage limit must be between 1 byte and 9 Petabytes",
          "error",
        );
        setUpdating(null);
        return;
      }

      await updateUserStorageLimit(userId, bytes);
      showToast("Storage limit updated successfully", "success");
      setEditingUserId(null);
      setEditValue("");
      setEditUnit("GB");
      onRefresh();
      if (userId === currentUserId) onStorageUpdated?.();
    } catch (error) {
      showToast(
        error instanceof Error
          ? error.message
          : "Failed to update storage limit",
        "error",
      );
    } finally {
      setUpdating(null);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="All Registered Users"
      size="xl"
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            {usersList.length > 0
              ? `${usersList.length} user${usersList.length === 1 ? "" : "s"} total`
              : "No users to display yet"}
          </p>
          <button
            onClick={onRefresh}
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

        {usersList.length > 0 && (
          <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
            <div className="flex items-center gap-2 mb-3">
              <Shield className="w-5 h-5 text-blue-600 dark:text-blue-400" />
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                MFA Statistics
              </h3>
            </div>
            <div className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <div className="text-gray-600 dark:text-gray-400 mb-1">
                  Enabled
                </div>
                <div className="flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-green-600 dark:text-green-400" />
                  <span className="font-semibold text-gray-900 dark:text-gray-100">
                    {mfaStats.enabled}
                  </span>
                </div>
              </div>
              <div>
                <div className="text-gray-600 dark:text-gray-400 mb-1">
                  Disabled
                </div>
                <div className="flex items-center gap-1.5">
                  <Shield className="w-4 h-4 text-gray-500 dark:text-gray-400" />
                  <span className="font-semibold text-gray-900 dark:text-gray-100">
                    {mfaStats.disabled}
                  </span>
                </div>
              </div>
              <div>
                <div className="text-gray-600 dark:text-gray-400 mb-1">
                  Adoption
                </div>
                <div className="font-semibold text-gray-900 dark:text-gray-100">
                  {mfaStats.percentage}%
                </div>
              </div>
            </div>
          </div>
        )}

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
                  <th className="py-2 pr-4 font-medium">Storage</th>
                  <th className="py-2 pr-4 font-medium">Limit</th>
                  <th className="py-2 pr-4 font-medium">MFA</th>
                  <th className="py-2 font-medium">Joined</th>
                </tr>
              </thead>
              <tbody>
                {usersList.map((listedUser) => {
                  const isEditing = editingUserId === listedUser.id;
                  const isUpdating = updating === listedUser.id;
                  const used = listedUser.storageUsed ?? 0;
                  const total = listedUser.storageTotal ?? 0;
                  const percentage =
                    total > 0 ? Math.round((used / total) * 100) : 0;

                  return (
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
                      <td className="py-2 pr-4">
                        <div className="flex items-center gap-2">
                          <HardDrive className="w-4 h-4 text-gray-500 dark:text-gray-400" />
                          <div className="flex flex-col">
                            <span className="text-gray-900 dark:text-gray-100 font-medium">
                              {formatFileSize(used)}
                            </span>
                            {total > 0 && (
                              <span className="text-xs text-gray-500 dark:text-gray-400">
                                {percentage}% of {formatFileSize(total)}
                              </span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="py-2 pr-4">
                        {isEditing ? (
                          <div className="flex items-center gap-1">
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              value={editValue}
                              onChange={(e) =>
                                handleNumberChange(e.target.value)
                              }
                              placeholder="0"
                              className="px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 w-20 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                              disabled={isUpdating}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  handleSaveLimit(listedUser.id);
                                } else if (e.key === "Escape") {
                                  handleCancelEdit();
                                }
                              }}
                              autoFocus
                            />
                            <select
                              value={editUnit}
                              onChange={(e) =>
                                setEditUnit(
                                  e.target.value as "MB" | "GB" | "TB",
                                )
                              }
                              disabled={isUpdating}
                              className="px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 cursor-pointer"
                            >
                              <option value="MB">MB</option>
                              <option value="GB">GB</option>
                              <option value="TB">TB</option>
                            </select>
                            <button
                              onClick={() => handleSaveLimit(listedUser.id)}
                              disabled={isUpdating}
                              className="p-1 text-green-600 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20 rounded disabled:opacity-50 transition-colors"
                              title="Save"
                            >
                              <Check className="w-4 h-4" />
                            </button>
                            <button
                              onClick={handleCancelEdit}
                              disabled={isUpdating}
                              className="p-1 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded disabled:opacity-50 transition-colors"
                              title="Cancel"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1">
                            <span className="text-gray-700 dark:text-gray-300 text-xs">
                              {listedUser.storageLimit === null ||
                              listedUser.storageLimit === undefined ||
                              listedUser.storageLimit === 0
                                ? "Default"
                                : formatFileSize(
                                    Number(listedUser.storageLimit),
                                  )}
                            </span>
                            <button
                              onClick={() => handleEditLimit(listedUser)}
                              disabled={isUpdating}
                              className="p-1 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded disabled:opacity-50 transition-colors"
                              title="Edit storage limit"
                            >
                              <Edit2 className="w-3 h-3" />
                            </button>
                          </div>
                        )}
                      </td>
                      <td className="py-2 pr-4">
                        {listedUser.mfaEnabled ? (
                          <span className="inline-flex items-center gap-1.5 text-green-600 dark:text-green-400">
                            <ShieldCheck className="w-4 h-4" />
                            <span className="text-xs font-medium">Enabled</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1.5 text-gray-500 dark:text-gray-400">
                            <Shield className="w-4 h-4" />
                            <span className="text-xs font-medium">
                              Disabled
                            </span>
                          </span>
                        )}
                      </td>
                      <td className="py-2 text-gray-600 dark:text-gray-400">
                        {formatSignupDate(listedUser.createdAt)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
};
