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
          className="fixed inset-0 z-40 bg-black bg-opacity-50 lg:hidden transition-opacity duration-300 animate-fadeIn"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div
        className={`
        fixed lg:static inset-y-0 left-0 z-50 w-64 bg-white/90 dark:bg-gray-900/90 backdrop-blur-md
        border-r border-gray-200 dark:border-gray-800 shadow-xl lg:shadow-none rounded-r-3xl lg:rounded-none
        transform transition-transform duration-300 ease-in-out
        ${sidebarOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"}
        ${!sidebarOpen ? "lg:w-0 lg:overflow-hidden" : ""}
      `}
      >
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="p-6 border-b border-gray-200 dark:border-gray-800">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <div className="w-10 h-10 bg-blue-500 rounded-xl flex items-center justify-center shadow-md">
                  <HardDrive className="w-6 h-6 text-white" />
                </div>
                <span className="text-2xl font-extrabold text-gray-900 dark:text-gray-100 tracking-tight">
                  CloudStore
                </span>
              </div>
              <button
                onClick={() => setSidebarOpen(false)}
                className="lg:hidden text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 transition-colors duration-200 rounded-lg p-2 hover:bg-gray-100 dark:hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-400"
                aria-label="Close sidebar"
              >
                <X className="w-6 h-6" />
              </button>
            </div>
          </div>

          {/* Navigation */}
          <nav className="flex-1 flex flex-col gap-1 p-4">
            {navigationItems.map((item) => {
              const Icon = item.icon;
              const active = isActive(item.path);

              return (
                <button
                  key={item.id}
                  onClick={() => handleNavigation(item.path)}
                  className={`
                    ripple w-full flex items-center space-x-3 px-4 py-2 rounded-xl text-left relative overflow-hidden
                    transition-all duration-200 hover:bg-blue-100/60 dark:hover:bg-blue-900/30 shadow-sm
                    focus:outline-none focus:ring-2 focus:ring-blue-400
                    ${
                      active
                        ? "bg-blue-50 text-blue-700 dark:bg-blue-900/60 dark:text-blue-300 shadow-md"
                        : "text-gray-700 dark:text-gray-300"
                    }
                  `}
                  aria-current={active ? "page" : undefined}
                >
                  {/* Active indicator bar */}
                  <span
                    className={`absolute left-0 top-2 bottom-2 w-1 rounded-full transition-all duration-300 ${active ? "bg-blue-500" : "bg-transparent"}`}
                  ></span>
                  <Icon
                    className={`w-5 h-5 ${active ? "text-blue-500" : ""}`}
                  />
                  <span className="font-semibold tracking-tight">
                    {item.label}
                  </span>
                </button>
              );
            })}
          </nav>

          {/* Settings */}
          <div className="p-4 border-t border-gray-200 dark:border-gray-800">
            <button
              onClick={() => handleNavigation(["Settings"])}
              className={`
                ripple w-full flex items-center space-x-3 px-4 py-2 rounded-xl text-left relative overflow-hidden
                transition-all duration-200 hover:bg-blue-100/60 dark:hover:bg-blue-900/30 shadow-sm
                focus:outline-none focus:ring-2 focus:ring-blue-400
                ${
                  isActive(["Settings"])
                    ? "bg-blue-50 text-blue-700 dark:bg-blue-900/60 dark:text-blue-300 shadow-md"
                    : "text-gray-700 dark:text-gray-300"
                }
              `}
              aria-current={isActive(["Settings"]) ? "page" : undefined}
            >
              {/* Active indicator bar */}
              <span
                className={`absolute left-0 top-2 bottom-2 w-1 rounded-full transition-all duration-300 ${isActive(["Settings"]) ? "bg-blue-500" : "bg-transparent"}`}
              ></span>
              <Settings
                className={`w-5 h-5 ${isActive(["Settings"]) ? "text-blue-500" : ""}`}
              />
              <span className="font-semibold tracking-tight">Settings</span>
            </button>
          </div>
        </div>
      </div>
    </>
  );
};
