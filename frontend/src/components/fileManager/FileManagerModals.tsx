import React from "react";
import { Modal } from "../ui/Modal";

interface EmptyTrashModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  fileCount: number;
}

export const EmptyTrashModal: React.FC<EmptyTrashModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  fileCount,
}) => {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Empty Trash" size="sm">
      <div className="space-y-4">
        <p className="text-gray-700 dark:text-gray-300">
          Are you sure you want to permanently delete all {fileCount} item(s)
          from trash? This action cannot be undone.
        </p>
        <div className="flex justify-end space-x-3 pt-4">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors duration-200"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 rounded-lg text-white bg-red-600 hover:bg-red-700 dark:bg-red-500 dark:hover:bg-red-600 transition-colors duration-200"
          >
            Empty Trash
          </button>
        </div>
      </div>
    </Modal>
  );
};

interface DeleteModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  fileCount: number;
}

export const DeleteModal: React.FC<DeleteModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  fileCount,
}) => {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Delete" size="sm">
      <div className="space-y-4">
        <p className="text-gray-700 dark:text-gray-300">
          Are you sure you want to move {fileCount} item
          {fileCount !== 1 ? "s" : ""} to trash?
        </p>
        <div className="flex justify-end space-x-3 pt-4">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors duration-200"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 rounded-lg text-white bg-red-600 hover:bg-red-700 dark:bg-red-500 dark:hover:bg-red-600 transition-colors duration-200"
          >
            Delete
          </button>
        </div>
      </div>
    </Modal>
  );
};

interface DeleteForeverModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  fileCount: number;
}

export const DeleteForeverModal: React.FC<DeleteForeverModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
  fileCount,
}) => {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Delete Forever" size="sm">
      <div className="space-y-4">
        <p className="text-gray-700 dark:text-gray-300">
          Are you sure you want to permanently delete {fileCount} item
          {fileCount !== 1 ? "s" : ""}? This action cannot be undone.
        </p>
        <div className="flex justify-end space-x-3 pt-4">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors duration-200"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 rounded-lg text-white bg-red-600 hover:bg-red-700 dark:bg-red-500 dark:hover:bg-red-600 transition-colors duration-200"
          >
            Delete Forever
          </button>
        </div>
      </div>
    </Modal>
  );
};
