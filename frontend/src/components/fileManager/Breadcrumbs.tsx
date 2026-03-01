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
        className={`flex items-center justify-center min-w-[2.25rem] min-h-[2.25rem] rounded-xl ${isMobile ? 'flex-shrink-0' : ''} text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-100 hover:bg-slate-200/50 dark:hover:bg-slate-700/50 transition-all duration-300 ease-out`}
      >
        <Home className="w-5 h-5" strokeWidth={2} />
      </button>

      {shouldTruncate && (
        <>
          <ChevronRight className="w-5 h-5 text-slate-400 dark:text-slate-500 flex-shrink-0" />
          <span className="text-slate-400 dark:text-slate-500 px-0.5 flex-shrink-0 text-sm">...</span>
        </>
      )}

      {displayPath.map((segment, index) => {
        const actualIndex = shouldTruncate ? (index === 0 ? currentPath.length - 2 : currentPath.length - 1) : index;

        return (
          <React.Fragment key={index}>
            <ChevronRight className="w-5 h-5 text-slate-400 dark:text-slate-500 flex-shrink-0" />
            <button
              onClick={() => handleNavigation(actualIndex)}
              className={`
                ${isMobile ? 'flex-shrink-0 whitespace-nowrap' : ''}
                py-1.5 px-2 rounded-xl hover:bg-slate-200/50 dark:hover:bg-slate-700/50
                hover:text-slate-800 dark:hover:text-slate-100 transition-all duration-300 ease-out
                ${
                  actualIndex === currentPath.length - 1
                    ? 'text-slate-800 dark:text-slate-100 font-semibold'
                    : 'text-slate-500 dark:text-slate-400'
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
