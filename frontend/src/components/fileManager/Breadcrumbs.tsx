import React from "react";
import { ChevronRight, Home } from "lucide-react";
import { useApp } from "../../contexts/AppContext";
import { useIsMobile } from "../../hooks/useIsMobile";

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
      className={`flex items-center ${isMobile ? "overflow-x-auto scrollbar-hide flex-1 min-w-0" : "space-x-1"} text-sm`}
    >
      <button
        onClick={() => setCurrentPath(["My Files"], [null])}
        className={`flex items-center ${isMobile ? "flex-shrink-0" : "space-x-1"} text-gray-500/80 hover:text-gray-700 dark:text-gray-400/80 dark:hover:text-gray-200 transition-colors duration-200`}
      >
        <Home className="w-4 h-4 icon-muted" />
      </button>

      {shouldTruncate && (
        <>
          <ChevronRight className="w-4 h-4 text-gray-400 flex-shrink-0" />
          <span className="text-gray-400 dark:text-gray-500 px-1 flex-shrink-0">
            ...
          </span>
        </>
      )}

      {displayPath.map((segment, index) => {
        const actualIndex = shouldTruncate
          ? index === 0
            ? currentPath.length - 2
            : currentPath.length - 1
          : index;

        return (
          <React.Fragment key={index}>
            <ChevronRight
              className={`w-4 h-4 text-gray-400/60 icon-muted ${isMobile ? "flex-shrink-0" : ""}`}
            />
            <button
              onClick={() => handleNavigation(actualIndex)}
              className={`
                ${isMobile ? "flex-shrink-0 whitespace-nowrap" : ""}
                hover:text-gray-700 dark:hover:text-gray-200 transition-colors duration-200
                ${
                  actualIndex === currentPath.length - 1
                    ? "text-gray-900 dark:text-gray-100 font-semibold"
                    : "text-gray-500/80 dark:text-gray-400/80"
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
