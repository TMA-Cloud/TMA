import React from "react";
import { AlertCircle, CheckCircle2 } from "lucide-react";
import { Modal } from "../../ui/Modal";
import type { UserCustomDriveInfo } from "../../../utils/api";

interface CustomDriveEnableModalProps {
  isOpen: boolean;
  onClose: () => void;
  userInfo: UserCustomDriveInfo | undefined;
  onCancel: () => void;
  onProceed: () => void;
}

export const CustomDriveEnableModal: React.FC<CustomDriveEnableModalProps> = ({
  isOpen,
  onClose,
  userInfo,
  onCancel,
  onProceed,
}) => {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Enable Custom Drive?"
      size="md"
    >
      {userInfo && (
        <div className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Enable custom drive for{" "}
            <strong>{userInfo.name || userInfo.email}</strong>?
          </p>
          <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-3">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-5 h-5 text-yellow-600 dark:text-yellow-400 mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-medium text-yellow-800 dark:text-yellow-300 mb-2">
                  Warning: This action will clean up the user's current upload
                  directory
                </p>
                <ul className="text-sm text-yellow-700 dark:text-yellow-400 space-y-1 list-disc list-inside">
                  <li>
                    All files in the user's current upload directory will be
                    removed from the database
                  </li>
                  <li>
                    Physical files in the upload directory will also be deleted
                  </li>
                  <li>
                    You will need to configure a custom drive path before
                    enabling
                  </li>
                  <li>
                    Once enabled, the path cannot be changed without disabling
                    first
                  </li>
                </ul>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3 justify-end">
            <button
              onClick={onCancel}
              className="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-md hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={onProceed}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors flex items-center gap-2"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>Continue</span>
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
};
