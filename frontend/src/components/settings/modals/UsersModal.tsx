import React from "react";
import { Loader2 } from "lucide-react";
import { format } from "date-fns";
import { Modal } from "../../ui/Modal";
import type { UserSummary } from "../../../utils/api";

interface UsersModalProps {
  isOpen: boolean;
  onClose: () => void;
  usersList: UserSummary[];
  loadingUsersList: boolean;
  usersListError: string | null;
  onRefresh: () => void;
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
}) => {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
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
  );
};
