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
    label: "Shared with Me",
    icon: Share2,
    path: ["Shared with Me"],
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
          className="fixed inset-0 z-40 bg-black bg-opacity-50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div
        className={`
        fixed lg:static inset-y-0 left-0 z-50 w-64 bg-white dark:bg-gray-900 
        border-r border-gray-200 dark:border-gray-800 transform transition-transform duration-300 ease-in-out
        ${sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}
        ${!sidebarOpen ? "lg:w-0 lg:overflow-hidden" : ""}
      `}
      >
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="p-6 border-b border-gray-200 dark:border-gray-800">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <div className="w-8 h-8 bg-blue-500 rounded-lg flex items-center justify-center">
                  <HardDrive className="w-5 h-5 text-white" />
                </div>
                <span className="text-xl font-bold text-gray-900 dark:text-gray-100">
                  CloudStore
                </span>
              </div>
              <button
                onClick={() => setSidebarOpen(false)}
                className="lg:hidden text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Navigation */}
          <nav className="flex-1 p-4 space-y-1">
            {navigationItems.map((item) => {
              const Icon = item.icon;
              const active = isActive(item.path);

              return (
                <button
                  key={item.id}
                  onClick={() => handleNavigation(item.path)}
                  className={`
                    w-full flex items-center space-x-3 px-3 py-2 rounded-lg text-left
                    transition-colors duration-200 hover:bg-gray-100 dark:hover:bg-gray-800
                    ${
                      active
                        ? "bg-blue-50 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300"
                        : "text-gray-700 dark:text-gray-300"
                    }
                  `}
                >
                  <Icon
                    className={`w-5 h-5 ${active ? "text-blue-500" : ""}`}
                  />
                  <span className="font-medium">{item.label}</span>
                </button>
              );
            })}
          </nav>

          {/* Settings */}
          <div className="p-4 border-t border-gray-200 dark:border-gray-800">
            <button
              onClick={() => handleNavigation(["Settings"])}
              className={`
                w-full flex items-center space-x-3 px-3 py-2 rounded-lg text-left
                transition-colors duration-200 hover:bg-gray-100 dark:hover:bg-gray-800
                ${
                  isActive(["Settings"])
                    ? "bg-blue-50 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300"
                    : "text-gray-700 dark:text-gray-300"
                }
              `}
            >
              <Settings
                className={`w-5 h-5 ${isActive(["Settings"]) ? "text-blue-500" : ""}`}
              />
              <span className="font-medium">Settings</span>
            </button>
          </div>
        </div>
      </div>
    </>
  );
};
