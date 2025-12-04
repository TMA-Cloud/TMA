import React from "react";
import { useApp } from "../../contexts/AppContext";
import { useAuth } from "../../contexts/AuthContext";
import { FileManager } from "../fileManager/FileManager";
import { Dashboard } from "../dashboard/Dashboard";
import { Settings } from "../settings/Settings";
import { UploadModal } from "../upload/UploadModal";
import { CreateFolderModal } from "../folder/CreateFolderModal";
import { ImageViewerModal } from "../viewer/ImageViewerModal";
import { DocumentViewerModal } from "../viewer/DocumentViewerModal";
import { RenameModal } from "../fileManager/RenameModal";
import { ShareLinkModal } from "../fileManager/ShareLinkModal";
import {
  Home,
  FolderOpen,
  Share2,
  Star,
  Trash2,
  Settings as SettingsIcon,
  HardDrive,
  Upload,
  LogOut,
} from "lucide-react";

const navItems = [
  { id: "Dashboard", label: "Home", icon: Home },
  { id: "My Files", label: "Files", icon: FolderOpen },
  { id: "Shared", label: "Shared", icon: Share2 },
  { id: "Starred", label: "Starred", icon: Star },
  { id: "Trash", label: "Trash", icon: Trash2 },
  { id: "Settings", label: "Settings", icon: SettingsIcon },
] as const;

export const MobileAppContent: React.FC = () => {
  const { currentPath, setCurrentPath, setUploadModalOpen } = useApp();
  const { user, logout } = useAuth();

  const currentPage = currentPath[0];

  const renderContent = () => {
    switch (currentPage) {
      case "Dashboard":
        return <Dashboard />;
      case "Settings":
        return <Settings />;
      case "My Files":
      case "Shared":
      case "Starred":
      case "Trash":
      default:
        return <FileManager />;
    }
  };

  const handleNavClick = (id: (typeof navItems)[number]["id"]) => {
    setCurrentPath([id]);
  };

  const getInitials = (name?: string | null) => {
    if (!name) return "U";
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase();
  };

  return (
    <div className="h-screen w-screen flex flex-col bg-gradient-to-b from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-950">
      {/* Compact top bar */}
      <header className="px-4 py-3 flex items-center justify-between bg-white/90 dark:bg-gray-900/90 border-b border-gray-200 dark:border-gray-800 shadow-sm">
        <div className="flex items-center space-x-2">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center shadow-md">
            <HardDrive className="w-5 h-5 text-white" />
          </div>
          <div className="flex flex-col">
            <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              CloudStore
            </span>
            <span className="text-[11px] text-gray-500 dark:text-gray-400">
              {currentPage}
            </span>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={() => setUploadModalOpen(true)}
            className="inline-flex items-center justify-center rounded-full bg-blue-500 text-white w-9 h-9 shadow-md active:scale-95 transition"
            aria-label="Upload"
          >
            <Upload className="w-4 h-4" />
          </button>
          <button
            onClick={logout}
            className="inline-flex items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 w-9 h-9 active:scale-95 transition"
            aria-label="Logout"
          >
            <LogOut className="w-4 h-4" />
          </button>
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center text-xs font-bold text-white">
            {getInitials(user?.name)}
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="flex-1 overflow-y-auto px-3 pt-3 pb-16">
        <div className="animate-fadeIn">{renderContent()}</div>
      </main>

      {/* Bottom navigation */}
      <nav className="fixed bottom-0 left-0 right-0 z-40 bg-white/95 dark:bg-gray-900/95 border-t border-gray-200 dark:border-gray-800 shadow-2xl shadow-black/10">
        <div className="flex justify-around py-1.5 px-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = currentPage === item.id;
            return (
              <button
                key={item.id}
                onClick={() => handleNavClick(item.id)}
                className="flex flex-col items-center flex-1 px-1 py-1 rounded-xl active:scale-95 transition"
              >
                <div
                  className={`flex items-center justify-center w-9 h-9 rounded-full text-xs ${
                    active
                      ? "bg-blue-500 text-white shadow-md"
                      : "text-gray-500 dark:text-gray-400"
                  }`}
                >
                  <Icon className="w-4 h-4" />
                </div>
                <span
                  className={`mt-0.5 text-[10px] font-medium ${
                    active
                      ? "text-blue-600 dark:text-blue-400"
                      : "text-gray-500 dark:text-gray-400"
                  }`}
                >
                  {item.label}
                </span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* Shared modals */}
      <UploadModal />
      <CreateFolderModal />
      <ImageViewerModal />
      <DocumentViewerModal />
      <RenameModal />
      <ShareLinkModal />
    </div>
  );
};
