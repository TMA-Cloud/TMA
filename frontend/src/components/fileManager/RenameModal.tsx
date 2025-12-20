import React, { useRef } from "react";
import { Modal } from "../ui/Modal";
import { useApp } from "../../contexts/AppContext";

export const RenameModal: React.FC = () => {
  const { renameTarget, setRenameTarget, renameFile } = useApp();
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClose = () => {
    setRenameTarget(null);
  };

  const handleRename = async () => {
    if (!renameTarget) return;
    const value = inputRef.current?.value ?? "";
    if (!value.trim()) return;
    try {
      await renameFile(renameTarget.id, value.trim());
      handleClose();
    } catch (error) {
      console.error("Failed to rename file:", error);
      // Error is handled by the API function, but we should still show user feedback
      // The error will be thrown and can be caught by the caller if needed
    }
  };

  if (!renameTarget) return null;

  return (
    <Modal isOpen onClose={handleClose} title="Rename">
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            New Name
          </label>
          <input
            type="text"
            key={renameTarget?.id}
            defaultValue={renameTarget?.name ?? ""}
            ref={inputRef}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="flex justify-end space-x-3">
          <button
            onClick={handleClose}
            className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors duration-200"
          >
            Cancel
          </button>
          <button
            onClick={handleRename}
            className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors duration-200"
          >
            Rename
          </button>
        </div>
      </div>
    </Modal>
  );
};
