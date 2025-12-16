import React from "react";
import {
  Home,
  FolderOpen,
  Share2,
  Star,
  Trash2,
  Settings,
  HardDrive,
  X,
} from "lucide-react";
import { useApp } from "../../contexts/AppContext";

const navigationItems = [
  { id: "dashboard", label: "Dashboard", icon: Home, path: ["Dashboard"] },
  { id: "files", label: "My Files", icon: FolderOpen, path: ["My Files"] },
  {
    id: "shared",
    label: "Shared",
    icon: Share2,
    path: ["Shared"],
  },
  { id: "starred", label: "Starred", icon: Star, path: ["Starred"] },
  { id: "trash", label: "Trash", icon: Trash2, path: ["Trash"] },
];

export const Sidebar: React.FC = () => {
  const { currentPath, setCurrentPath, sidebarOpen, setSidebarOpen } = useApp();

  const handleNavigation = (path: string[]) => {
    setCurrentPath(path);
    if (window.innerWidth < 768) {
      setSidebarOpen(false);
    }
  };

  const isActive = (path: string[]) => {
    return currentPath[0] === path[0];
  };

  return (
    <>
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black bg-opacity-50 lg:hidden transition-opacity duration-300 animate-fadeIn"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div
        className={`
        fixed lg:static inset-y-0 left-0 z-50 w-64 bg-white dark:bg-slate-900 backdrop-blur-xl
        border-r border-gray-200/50 dark:border-slate-800/50 shadow-2xl lg:shadow-none rounded-r-3xl lg:rounded-none
        transform transition-all duration-300 ease-out
        ${sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}
        ${!sidebarOpen ? "lg:w-0 lg:overflow-hidden" : ""}
      `}
      >
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="p-6 border-b border-gray-200/50 dark:border-slate-800/50">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2 animate-slideDown">
                <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-blue-600 rounded-xl flex items-center justify-center shadow-lg transition-all duration-200 hover:shadow-xl">
                  <HardDrive className="w-6 h-6 text-white" />
                </div>
                <span className="text-2xl font-extrabold text-gray-900 dark:text-gray-100 tracking-tight bg-gradient-to-r from-blue-600 to-blue-500 bg-clip-text text-transparent">
                  CloudStore
                </span>
              </div>
              <button
                onClick={() => setSidebarOpen(false)}
                className="lg:hidden text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-all duration-200 rounded-lg p-2 hover:bg-gray-100 dark:hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-400 active:scale-95"
                aria-label="Close sidebar"
              >
                <X className="w-6 h-6" />
              </button>
            </div>
          </div>

          {/* Navigation */}
          <nav className="flex-1 flex flex-col gap-2 p-4">
            {navigationItems.map((item) => {
              const Icon = item.icon;
              const active = isActive(item.path);

              return (
                <button
                  key={item.id}
                  onClick={() => handleNavigation(item.path)}
                  className={`
                    group stagger-item ripple w-full flex items-center space-x-3 px-4 py-3.5 rounded-xl text-left relative overflow-hidden
                    transition-all duration-200 ease-out
                    focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-2 focus:ring-offset-transparent
                    ${
                      active
                        ? "bg-blue-500/20 dark:bg-blue-500/30 text-blue-700 dark:text-blue-200 font-semibold shadow-md border-l-4 border-blue-500 dark:border-blue-400"
                        : "text-gray-600 dark:text-gray-400 hover:bg-gray-100/60 dark:hover:bg-gray-800/60 hover:text-gray-900 dark:hover:text-gray-200"
                    }
                  `}
                  aria-current={active ? "page" : undefined}
                >
                  {/* Active indicator glow */}
                  {active && (
                    <span className="absolute inset-0 bg-gradient-to-r from-blue-500/10 to-transparent dark:from-blue-400/20 rounded-xl"></span>
                  )}
                  <Icon
                    className={`w-5 h-5 relative z-10 transition-all duration-200 ${
                      active
                        ? "text-blue-600 dark:text-blue-300 scale-110 icon-rotate-active"
                        : "text-gray-500 dark:text-gray-400 group-hover:scale-105 icon-rotate-on-hover"
                    }`}
                  />
                  <span
                    className={`relative z-10 transition-all duration-200 ${
                      active ? "font-semibold" : "font-medium"
                    }`}
                  >
                    {item.label}
                  </span>
                </button>
              );
            })}
          </nav>

          {/* Settings */}
          <div className="p-4 border-t border-gray-200/50 dark:border-gray-800/50">
            <button
              onClick={() => handleNavigation(["Settings"])}
              className={`
                group ripple w-full flex items-center space-x-3 px-4 py-3.5 rounded-xl text-left relative overflow-hidden
                transition-all duration-200 ease-out
                focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-2 focus:ring-offset-transparent
                ${
                  isActive(["Settings"])
                    ? "bg-blue-500/20 dark:bg-blue-500/30 text-blue-700 dark:text-blue-200 font-semibold shadow-md border-l-4 border-blue-500 dark:border-blue-400"
                    : "text-gray-600 dark:text-gray-400 hover:bg-gray-100/60 dark:hover:bg-gray-800/60 hover:text-gray-900 dark:hover:text-gray-200"
                }
              `}
              aria-current={isActive(["Settings"]) ? "page" : undefined}
            >
              {/* Active indicator glow */}
              {isActive(["Settings"]) && (
                <span className="absolute inset-0 bg-gradient-to-r from-blue-500/10 to-transparent dark:from-blue-400/20 rounded-xl"></span>
              )}
              <Settings
                className={`w-5 h-5 relative z-10 transition-all duration-200 ${
                  isActive(["Settings"])
                    ? "text-blue-600 dark:text-blue-300 scale-110 icon-rotate-active"
                    : "text-gray-500 dark:text-gray-400 group-hover:scale-105 icon-rotate-on-hover"
                }`}
              />
              <span
                className={`relative z-10 transition-all duration-200 ${
                  isActive(["Settings"]) ? "font-semibold" : "font-medium"
                }`}
              >
                Settings
              </span>
            </button>
          </div>
        </div>
      </div>
    </>
  );
};
