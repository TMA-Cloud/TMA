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

  const isDropZoneContext = canCreateFolder && searchQuery.trim().length === 0;
  return (
    <div
      className={`
        flex flex-col items-center justify-center text-center select-none animate-fadeIn w-full
        ${isDropZoneContext ? 'min-h-[calc(100vh-18rem)] rounded-2xl border-2 border-dashed border-slate-200 dark:border-slate-600' : 'h-64'}
      `}
    >
      <svg width="80" height="80" fill="none" viewBox="0 0 80 80" className="mb-4 animate-bounceIn flex-shrink-0">
        <rect width="80" height="80" rx="20" fill="#e2e7ee" className="dark:fill-slate-800" />
        <path
          d="M24 56V32a4 4 0 014-4h24a4 4 0 014 4v24"
          stroke="#5b8def"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path d="M32 40h16" stroke="#5b8def" strokeWidth="2" strokeLinecap="round" />
        <path d="M32 48h16" stroke="#5b8def" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <h3 className="text-lg font-semibold text-slate-700 dark:text-slate-300 mb-2">{getTitle()}</h3>
      <p className="text-slate-500 dark:text-slate-400 mb-1">{getDescription()}</p>
      {isDropZoneContext && (
        <p className="text-sm text-slate-400 dark:text-slate-500 mb-4">Drop files or folders anywhere in this area</p>
      )}
      {canCreateFolder && searchQuery.trim().length === 0 && (
        <button
          className="px-6 py-3 bg-gradient-to-r from-[#5b8def] to-[#4a7edb] hover:from-[#4a7edb] hover:to-[#3d6ec7] text-white rounded-2xl shadow-soft hover:shadow-soft-md transition-all duration-300 ease-out font-semibold active:scale-[0.98] animate-bounceIn"
          onClick={onCreateFolder}
        >
          Create Folder
        </button>
      )}
    </div>
  );
};
