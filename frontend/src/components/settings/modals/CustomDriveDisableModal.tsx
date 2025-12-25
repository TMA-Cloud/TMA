import React from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { Modal } from "../../ui/Modal";
import type { UserCustomDriveInfo } from "../../../utils/api";
import type { UserCustomDriveLocalState } from "../hooks/useCustomDriveManagement";

interface CustomDriveDisableModalProps {
  isOpen: boolean;
  onClose: () => void;
  userInfo: UserCustomDriveInfo | undefined;
  localState: UserCustomDriveLocalState[string] | undefined;
  updating: boolean;
  onCancel: () => void;
  onProceed: () => void;
}

export const CustomDriveDisableModal: React.FC<
  CustomDriveDisableModalProps
> = ({
  isOpen,
  onClose,
  userInfo,
  localState,
  updating,
  onCancel,
  onProceed,
}) => {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Disable Custom Drive?"
      size="md"
    >
      {userInfo && (
        <div className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Disable custom drive for{" "}
            <strong>{userInfo.name || userInfo.email}</strong>?
          </p>
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-medium text-red-800 dark:text-red-300 mb-2">
                  Warning: This action cannot be undone
                </p>
                <ul className="text-sm text-red-700 dark:text-red-400 space-y-1 list-disc list-inside">
                  <li>
                    All custom drive files will be removed from the database
                  </li>
                  <li>The file watcher will be stopped</li>
                  <li>
                    The user will need to set up custom drive again if you want
                    to re-enable it
                  </li>
                </ul>
              </div>
            </div>
          </div>
          {localState?.path && (
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Current path:{" "}
              <span className="font-mono bg-gray-100 dark:bg-gray-800 px-2 py-1 rounded">
                {localState.path}
              </span>
            </p>
          )}
          <div className="flex items-center gap-3 justify-end">
            <button
              onClick={onCancel}
              className="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-md hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={onProceed}
              disabled={updating}
              className="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
            >
              {updating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Disabling...</span>
                </>
              ) : (
                <>
                  <AlertCircle className="w-4 h-4" />
                  <span>Yes, Disable Custom Drive</span>
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
};
