import React from 'react';
import { ChevronRight, Home } from 'lucide-react';
import { useApp } from '../../contexts/AppContext';
import { useIsMobile } from '../../hooks/useIsMobile';

export const Breadcrumbs: React.FC = () => {
  const { currentPath, navigateTo, setCurrentPath } = useApp();
  const isMobile = useIsMobile();

  const handleNavigation = (index: number) => {
    navigateTo(index);
  };

  // On mobile, show only the last 2 segments with ellipsis if needed
  const shouldTruncate = isMobile && currentPath.length > 2;
  const displayPath = shouldTruncate
    ? [currentPath[currentPath.length - 2], currentPath[currentPath.length - 1]]
    : currentPath;

  return (
    <nav
      className={`flex items-center ${isMobile ? 'overflow-x-auto scrollbar-hide flex-1 min-w-0' : 'gap-1.5'} text-base min-h-10`}
    >
      <button
        onClick={() => setCurrentPath(['My Files'], [null])}
        className={`flex items-center justify-center min-w-[2.25rem] min-h-[2.25rem] rounded-lg ${isMobile ? 'flex-shrink-0' : ''} text-gray-600 dark:text-gray-300 hover:text-gray-800 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700/50 transition-colors duration-200`}
      >
        <Home className="w-5 h-5" strokeWidth={2} />
      </button>

      {shouldTruncate && (
        <>
          <ChevronRight className="w-5 h-5 text-gray-500 dark:text-gray-400 flex-shrink-0" />
          <span className="text-gray-500 dark:text-gray-400 px-0.5 flex-shrink-0 text-sm">...</span>
        </>
      )}

      {displayPath.map((segment, index) => {
        const actualIndex = shouldTruncate ? (index === 0 ? currentPath.length - 2 : currentPath.length - 1) : index;

        return (
          <React.Fragment key={index}>
            <ChevronRight className="w-5 h-5 text-gray-500 dark:text-gray-400 flex-shrink-0" />
            <button
              onClick={() => handleNavigation(actualIndex)}
              className={`
                ${isMobile ? 'flex-shrink-0 whitespace-nowrap' : ''}
                py-1.5 px-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700/50
                hover:text-gray-800 dark:hover:text-gray-100 transition-colors duration-200
                ${
                  actualIndex === currentPath.length - 1
                    ? 'text-gray-900 dark:text-gray-100 font-semibold'
                    : 'text-gray-600 dark:text-gray-300'
                }
              `}
            >
              {segment}
            </button>
          </React.Fragment>
        );
      })}
    </nav>
  );
};
