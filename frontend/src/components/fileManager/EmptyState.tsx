import React from 'react';

interface EmptyStateProps {
  searchQuery: string;
  isSearching: boolean;
  currentPath: string[];
  canCreateFolder: boolean;
  onCreateFolder: () => void;
}

export const EmptyState: React.FC<EmptyStateProps> = ({
  searchQuery,
  isSearching,
  currentPath,
  canCreateFolder,
  onCreateFolder,
}) => {
  const getTitle = () => {
    if (searchQuery.trim().length > 0) {
      return isSearching ? 'Searching...' : 'No results found';
    }
    if (currentPath[0] === 'Starred') return 'No starred files';
    if (currentPath[0] === 'Shared') return 'No shared files';
    if (currentPath[0] === 'Trash') return 'Trash is empty';
    return 'No files or folders';
  };

  const getDescription = () => {
    if (searchQuery.trim().length > 0) {
      return isSearching ? 'Please wait while we search your files...' : `No files or folders match "${searchQuery}"`;
    }
    if (currentPath[0] === 'Starred') return 'Star files to easily find them later.';
    if (currentPath[0] === 'Shared') return 'Files others share with you will show up here.';
    if (currentPath[0] === 'Trash') return 'Deleted files will appear here.';
    return 'Upload or create a folder to get started.';
  };

  return (
    <div className="flex flex-col items-center justify-center h-64 text-center select-none animate-fadeIn">
      <svg width="80" height="80" fill="none" viewBox="0 0 80 80" className="mb-4 animate-bounceIn">
        <rect width="80" height="80" rx="20" fill="#e0e7ef" className="dark:fill-gray-800" />
        <path
          d="M24 56V32a4 4 0 014-4h24a4 4 0 014 4v24"
          stroke="#60a5fa"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M32 40h16" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" />
        <path d="M32 48h16" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <h3 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-2">{getTitle()}</h3>
      <p className="text-gray-500 dark:text-gray-400 mb-4">{getDescription()}</p>
      {canCreateFolder && searchQuery.trim().length === 0 && (
        <button
          className="px-6 py-3 bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white rounded-xl shadow-lg hover:shadow-xl transition-all duration-300 font-semibold hover:scale-105 active:scale-95 transform animate-bounceIn"
          onClick={onCreateFolder}
        >
          Create Folder
        </button>
      )}
    </div>
  );
};
