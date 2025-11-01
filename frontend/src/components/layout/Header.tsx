import React, { useState, useEffect } from "react";
import { Menu, Search, Upload, LogOut, X } from "lucide-react";
import { useApp } from "../../contexts/AppContext";
import { useAuth } from "../../contexts/AuthContext";

export const Header: React.FC = () => {
  const {
    sidebarOpen,
    setSidebarOpen,
    setUploadModalOpen,
    searchQuery,
    setSearchQuery,
    isSearching,
  } = useApp();
  const { logout, user } = useAuth();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Helper for avatar
  const getInitials = (name?: string) => {
    if (!name) return "?";
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase();
  };

  return (
    <header
      className={`bg-white/90 dark:bg-gray-900/90 border-b border-gray-200 dark:border-gray-800 px-4 sm:px-8 py-4 backdrop-blur-md transition-all duration-300 sticky top-0 z-40 ${scrolled ? "shadow-lg" : "shadow-md"}`}
    >
      <div className="flex items-center justify-between">
        {/* Left section */}
        <div className="flex items-center space-x-2 sm:space-x-4">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="ripple text-gray-500 hover:text-blue-600 dark:text-gray-400 dark:hover:text-blue-400 transition-colors duration-200 rounded-lg p-2 hover:bg-gray-100 dark:hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-400"
            aria-label="Open sidebar"
          >
            <Menu className="w-6 h-6 transition-transform duration-200 group-hover:scale-110" />
          </button>

          {/* Search */}
          <div className="relative hidden md:block w-48 sm:w-80 lg:w-96">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4 pointer-events-none" />
            <input
              type="text"
              placeholder="Search files and folders..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-10 py-2 bg-gray-50/80 dark:bg-gray-800/80 border border-gray-200 dark:border-gray-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent shadow-sm transition-all duration-200 text-gray-900 dark:text-gray-100 placeholder-gray-400"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-3 top-1/2 transform -translate-y-1/2 p-1 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                aria-label="Clear search"
              >
                <X className="w-4 h-4" />
              </button>
            )}
            {isSearching && searchQuery && (
              <div className="absolute right-10 top-1/2 transform -translate-y-1/2">
                <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              </div>
            )}
          </div>
        </div>

        {/* Right section */}
        <div className="flex items-center space-x-1 sm:space-x-2">
          <button
            onClick={() => setUploadModalOpen(true)}
            className="ripple flex items-center space-x-2 px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg shadow-md transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-blue-400"
          >
            <Upload className="w-4 h-4 transition-transform duration-200 group-hover:scale-110" />
            <span className="hidden sm:inline">Upload</span>
          </button>

          <button
            onClick={logout}
            className="ripple p-2 text-gray-500 hover:text-red-500 dark:text-gray-400 dark:hover:text-red-400 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-red-400"
            aria-label="Logout"
          >
            <LogOut className="w-5 h-5 transition-transform duration-200 group-hover:scale-110" />
          </button>

          <div className="flex items-center space-x-2 p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer transition-colors duration-200">
            {/* Avatar: If you add avatarUrl to user in the future, use it here. For now, always show initials. */}
            <div className="w-8 h-8 bg-blue-500 rounded-full flex items-center justify-center shadow-md text-white font-bold text-base">
              {getInitials(user?.name) || "U"}
            </div>
            <div className="hidden sm:block">
              <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {user?.name || "Personal Cloud"}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {user?.email || "Your Files"}
              </p>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
};
