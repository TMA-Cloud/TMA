import React from 'react';

interface FileSkeletonProps {
  viewMode: 'grid' | 'list';
  count?: number;
}

export const FileSkeleton: React.FC<FileSkeletonProps> = ({ viewMode, count = 12 }) => {
  if (viewMode === 'grid') {
    return (
      <>
        {Array.from({ length: count }).map((_, index) => (
          <div
            key={index}
            className="p-3 rounded-xl border-2 border-gray-200 dark:border-gray-700 bg-white/80 dark:bg-gray-800/80 stagger-item"
          >
            <div className="flex flex-col items-center text-center">
              <div className="w-12 h-12 mb-1.5 skeleton" />
              <div className="w-24 h-4 mb-1 skeleton" />
              <div className="w-16 h-3 skeleton" />
            </div>
          </div>
        ))}
      </>
    );
  }

  return (
    <>
      {Array.from({ length: count }).map((_, index) => (
        <div
          key={index}
          className="flex items-center space-x-3 py-2.5 px-3 rounded-lg bg-white/80 dark:bg-gray-800/80 stagger-item"
        >
          <div className="w-10 h-10 flex-shrink-0 skeleton" />
          <div className="flex-1 space-y-2">
            <div className="w-48 h-4 skeleton" />
            <div className="w-32 h-3 skeleton" />
          </div>
        </div>
      ))}
    </>
  );
};
