import React, { useState, useRef } from 'react';
import { Modal } from '../ui/Modal';
import { useApp } from '../../contexts/AppContext';

export const CreateFolderModal: React.FC = () => {
  const { createFolderModalOpen, setCreateFolderModalOpen, createFolder } = useApp();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleClose = () => {
    setCreateFolderModalOpen(false);
    setName('');
    setError('');
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      setError('Folder name cannot be empty');
      return;
    }
    try {
      await createFolder(name.trim());
      handleClose();
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to create folder. Please try again.';
      setError(errorMessage);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleCreate();
    if (e.key === 'Escape') handleClose();
  };

  return (
    <Modal
      isOpen={createFolderModalOpen}
      onClose={handleClose}
      title="New Folder"
      initialFocusRef={inputRef as React.RefObject<HTMLElement>}
    >
      <div className="space-y-4 animate-bounceIn">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Folder Name</label>
          <input
            ref={inputRef}
            type="text"
            value={name}
            onChange={e => {
              setName(e.target.value);
              setError('');
            }}
            onKeyDown={handleKeyDown}
            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {error && <p className="text-red-500 text-xs mt-1 animate-bounceIn">{error}</p>}
        </div>
        <div className="flex justify-end space-x-3">
          <button
            onClick={handleClose}
            className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors duration-200"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors duration-200"
          >
            Create
          </button>
        </div>
      </div>
    </Modal>
  );
};
