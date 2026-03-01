import React, { useRef } from 'react';
import { Modal } from '../ui/Modal';
import { useApp } from '../../contexts/AppContext';
import { getDisplayFileName, getFullNameForRename } from '../../utils/fileUtils';

export const RenameModal: React.FC = () => {
  const { renameTarget, setRenameTarget, renameFile, hideFileExtensions } = useApp();
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClose = () => {
    setRenameTarget(null);
  };

  const handleRename = async () => {
    if (!renameTarget) return;
    const value = inputRef.current?.value ?? '';
    if (!value.trim()) return;
    const isFile = renameTarget.type === 'file';
    const nameToSubmit =
      hideFileExtensions && isFile ? getFullNameForRename(value.trim(), renameTarget.name) : value.trim();
    try {
      await renameFile(renameTarget.id, nameToSubmit);
      handleClose();
    } catch {
      // Error already handled by renameFileApi (toast shown)
      // Close modal on any error
      handleClose();
    }
  };

  if (!renameTarget) return null;

  const initialDisplayValue = getDisplayFileName(renameTarget.name, renameTarget.type === 'file', hideFileExtensions);

  return (
    <Modal isOpen onClose={handleClose} title="Rename" initialFocusRef={inputRef as React.RefObject<HTMLElement>}>
      <form
        className="space-y-4"
        onSubmit={e => {
          e.preventDefault();
          handleRename();
        }}
      >
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">New Name</label>
          <input
            type="text"
            key={renameTarget?.id}
            defaultValue={initialDisplayValue}
            ref={inputRef}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-[#dfe3ea] dark:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
            autoFocus
          />
        </div>
        <div className="flex justify-end space-x-3">
          <button
            type="button"
            onClick={handleClose}
            className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors duration-200"
          >
            Cancel
          </button>
          <button
            type="submit"
            className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors duration-200"
          >
            Rename
          </button>
        </div>
      </form>
    </Modal>
  );
};
