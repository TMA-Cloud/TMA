import React from "react";
import { ChevronRight, Home } from "lucide-react";
import { useApp } from "../../contexts/AppContext";

export const Breadcrumbs: React.FC = () => {
  const { currentPath, setCurrentPath } = useApp();

  const handleNavigation = (index: number) => {
    const newPath = currentPath.slice(0, index + 1);
    setCurrentPath(newPath);
  };

  return (
    <nav className="flex items-center space-x-1 text-sm">
      <button
        onClick={() => setCurrentPath(["My Files"])}
        className="flex items-center space-x-1 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
      >
        <Home className="w-4 h-4" />
      </button>

      {currentPath.map((segment, index) => (
        <React.Fragment key={index}>
          <ChevronRight className="w-4 h-4 text-gray-400" />
          <button
            onClick={() => handleNavigation(index)}
            className={`
              hover:text-gray-700 dark:hover:text-gray-200 transition-colors
              ${
                index === currentPath.length - 1
                  ? "text-gray-900 dark:text-gray-100 font-medium"
                  : "text-gray-500 dark:text-gray-400"
              }
            `}
          >
            {segment}
          </button>
        </React.Fragment>
      ))}
    </nav>
  );
};
