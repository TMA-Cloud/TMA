import React, { useState, useEffect, useRef } from "react";
import { useApp } from "../../contexts/AppContext";
import { useAuth } from "../../contexts/AuthContext";
import FileManager from "../fileManager/FileManager";
import Dashboard from "../dashboard/Dashboard";
import Settings from "../settings/Settings";
import { UploadModal } from "../upload/UploadModal";
import { UploadProgress } from "../upload/UploadProgress";
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
  ChevronDown,
} from "lucide-react";

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

function scrollToTopFast(el: HTMLElement, durationMs = 180) {
  // Respect reduced-motion preference
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
    el.scrollTo({ top: 0, behavior: "auto" });
    return;
  }

  const startTop = el.scrollTop;
  if (startTop <= 0) return;

  const start = performance.now();
  const tick = (now: number) => {
    const t = Math.min(1, (now - start) / durationMs);
    const eased = easeOutCubic(t);
    el.scrollTop = Math.round(startTop * (1 - eased));
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const navItems = [
  { id: "Dashboard", label: "Home", icon: Home },
  { id: "My Files", label: "Files", icon: FolderOpen },
  { id: "Shared", label: "Shared", icon: Share2 },
  { id: "Starred", label: "Starred", icon: Star },
  { id: "Trash", label: "Trash", icon: Trash2 },
  { id: "Settings", label: "Settings", icon: SettingsIcon },
] as const;

export const MobileAppContent: React.FC = () => {
  const {
    currentPath,
    setCurrentPath,
    setUploadModalOpen,
    uploadProgress,
    setUploadProgress,
    setIsUploadProgressInteracting,
  } = useApp();
  const { user, logout } = useAuth();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const currentPage = currentPath[0];

  const mainRef = useRef<HTMLElement | null>(null);

  // Always reset the main scroll area to the top when navigating to a new path/folder
  useEffect(() => {
    if (mainRef.current) {
      scrollToTopFast(mainRef.current, 180);
    }
  }, [currentPath]);

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

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setDropdownOpen(false);
      }
    };

    if (dropdownOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [dropdownOpen]);

  return (
    <div className="h-screen w-screen flex flex-col bg-gray-50 dark:bg-slate-900">
      {/* Backdrop - covers entire screen when dropdown is open */}
      {dropdownOpen && (
        <div
          className="fixed inset-0 bg-black/40 dark:bg-black/60 backdrop-blur-sm animate-fadeIn z-[9998]"
          onClick={() => setDropdownOpen(false)}
        />
      )}

      {/* Compact top bar */}
      <header className="relative px-4 py-3 flex items-center justify-between bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl border-b border-gray-200/50 dark:border-slate-800/50 shadow-sm z-[9999]">
        <div className="flex items-center space-x-2">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center shadow-lg transition-all duration-200">
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
            className="inline-flex items-center justify-center rounded-full bg-blue-500 hover:bg-blue-600 text-white w-10 h-10 shadow-lg hover:shadow-xl transition-all duration-200 active:scale-95"
            aria-label="Upload"
          >
            <Upload className="w-4 h-4 transition-transform duration-200" />
          </button>

          {/* Profile Dropdown */}
          <div className="relative z-[10000]" ref={dropdownRef}>
            <button
              onClick={() => setDropdownOpen(!dropdownOpen)}
              className="flex items-center space-x-1 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-2 rounded-lg px-1.5 py-1 transition-all duration-200 relative z-[10001]"
            >
              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center text-xs font-bold text-white shadow-lg transition-all duration-200">
                {getInitials(user?.name)}
              </div>
              <ChevronDown
                className={`w-3 h-3 text-gray-500 dark:text-gray-400 transition-transform duration-300 ease-in-out ${
                  dropdownOpen ? "rotate-180" : ""
                }`}
              />
            </button>

            {/* Dropdown Menu */}
            {dropdownOpen && (
              <div className="absolute right-0 mt-2 w-40 bg-white/95 dark:bg-slate-800/95 backdrop-blur-xl rounded-xl shadow-2xl border border-gray-200/50 dark:border-slate-700/50 py-1 z-[10002] overflow-hidden animate-menuIn">
                <button
                  onClick={() => {
                    logout();
                    setDropdownOpen(false);
                  }}
                  className="w-full flex items-center space-x-3 px-4 py-2.5 text-left text-gray-700 dark:text-gray-300 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-600 dark:hover:text-red-400 transition-all duration-200 group rounded-lg mx-1"
                >
                  <LogOut className="w-4 h-4 transition-transform duration-200 group-hover:scale-110 group-hover:-translate-x-0.5" />
                  <span className="text-sm font-medium transition-colors duration-200">
                    Log out
                  </span>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main content */}
      <main ref={mainRef} className="flex-1 overflow-y-auto px-3 pt-3 pb-16">
        <div className="animate-fadeIn">{renderContent()}</div>
      </main>

      {/* Bottom navigation */}
      <nav className="fixed bottom-0 left-0 right-0 z-40 bg-white/95 dark:bg-slate-900/95 backdrop-blur-xl border-t border-gray-200/50 dark:border-slate-800/50 shadow-2xl">
        <div className="flex justify-around py-1.5 px-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = currentPage === item.id;
            return (
              <button
                key={item.id}
                onClick={() => handleNavClick(item.id)}
                className="group flex flex-col items-center flex-1 px-1.5 py-1.5 rounded-xl active:scale-95 transition-all duration-200"
              >
                <div
                  className={`flex items-center justify-center w-10 h-10 rounded-full text-xs transition-all duration-200 ${
                    active
                      ? "bg-blue-500/20 dark:bg-blue-500/30 text-blue-600 dark:text-blue-300 shadow-md"
                      : "text-gray-500/80 dark:text-gray-400/80"
                  }`}
                >
                  <Icon
                    className={`w-4 h-4 transition-all duration-200 ${
                      active ? "icon-rotate-active" : "icon-rotate-on-hover"
                    }`}
                  />
                </div>
                <span
                  className={`mt-0.5 text-[10px] font-medium transition-colors duration-200 ${
                    active
                      ? "text-blue-600 dark:text-blue-400 font-semibold"
                      : "text-gray-500/80 dark:text-gray-400/80"
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
      <UploadProgress
        uploads={uploadProgress}
        onDismiss={(id) => {
          setUploadProgress((prev) => prev.filter((item) => item.id !== id));
        }}
        onInteractionChange={setIsUploadProgressInteracting}
      />
    </div>
  );
};

export default MobileAppContent;
