import React, { useState, useEffect } from "react";
import { Modal } from "../ui/Modal";
import { useApp } from "../../contexts/AppContext";

export const RenameModal: React.FC = () => {
  const { renameTarget, setRenameTarget, renameFile } = useApp();
  const [name, setName] = useState("");

  useEffect(() => {
    if (renameTarget) {
      setName(renameTarget.name);
    }
  }, [renameTarget]);

  const handleClose = () => {
    setRenameTarget(null);
    setName("");
  };

  const handleRename = async () => {
    if (!renameTarget) return;
    if (!name.trim()) return;
    await renameFile(renameTarget.id, name.trim());
    handleClose();
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
            value={name}
            onChange={(e) => setName(e.target.value)}
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
