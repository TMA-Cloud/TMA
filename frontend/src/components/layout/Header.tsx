import React, { useState, useEffect, useRef } from 'react';
import { Menu, Search, Upload, LogOut, X, ChevronDown } from 'lucide-react';
import { useApp } from '../../contexts/AppContext';
import { useAuth } from '../../contexts/AuthContext';

export const Header: React.FC = () => {
  const { sidebarOpen, setSidebarOpen, setUploadModalOpen, searchQuery, setSearchQuery, isSearching } = useApp();
  const { logout, user } = useAuth();
  const [scrolled, setScrolled] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener('scroll', onScroll);
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    };

    if (dropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [dropdownOpen]);

  // Helper for avatar
  const getInitials = (name?: string) => {
    if (!name) return '?';
    return name
      .split(' ')
      .map(n => n[0])
      .join('')
      .toUpperCase();
  };

  return (
    <header
      className={`bg-white/95 dark:bg-slate-900/95 border-b border-gray-200/50 dark:border-slate-800/50 px-4 sm:px-8 py-4 backdrop-blur-xl transition-all duration-300 sticky top-0 z-40 ${scrolled ? 'shadow-lg' : 'shadow-sm'}`}
    >
      <div className="flex items-center justify-between">
        {/* Left section */}
        <div className="flex items-center space-x-2 sm:space-x-4">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="ripple text-gray-500 hover:text-blue-600 dark:text-gray-400 dark:hover:text-blue-400 transition-all duration-300 rounded-lg p-2 hover:bg-gray-100 dark:hover:bg-gray-800 focus:outline-none focus:ring-2 focus:ring-blue-400 hover:scale-110 active:scale-95"
            aria-label="Open sidebar"
          >
            <Menu className="w-6 h-6 transition-transform duration-300" />
          </button>

          {/* Search */}
          <div className="relative hidden md:block w-48 sm:w-80 lg:w-96">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4 pointer-events-none transition-colors duration-300" />
            <input
              type="text"
              placeholder="Search files and folders..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-10 py-2 bg-gray-50/80 dark:bg-gray-800/80 border border-gray-200 dark:border-gray-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent shadow-sm transition-all duration-300 text-gray-900 dark:text-gray-100 placeholder-gray-400 hover:shadow-md focus:shadow-lg focus:bg-white dark:focus:bg-gray-800"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 transform -translate-y-1/2 p-1 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-all duration-300 hover:scale-110 active:scale-95 animate-scaleIn"
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
            className="ripple flex items-center space-x-2 px-5 py-2.5 bg-blue-500 hover:bg-blue-600 text-white rounded-xl shadow-lg hover:shadow-xl transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-2 hover-lift font-semibold"
          >
            <Upload className="w-4 h-4 transition-transform duration-200" />
            <span className="hidden sm:inline">Upload</span>
          </button>

          {/* Profile Dropdown */}
          <div className="relative" ref={dropdownRef}>
            <button
              onClick={() => setDropdownOpen(!dropdownOpen)}
              className="flex items-center space-x-2 p-2 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-offset-2"
            >
              {/* Avatar: If you add avatarUrl to user in the future, use it here. For now, always show initials. */}
              <div className="w-8 h-8 bg-gradient-to-br from-blue-500 to-blue-600 rounded-full flex items-center justify-center shadow-lg text-white font-bold text-base transition-all duration-200 hover:shadow-xl">
                {getInitials(user?.name) || 'U'}
              </div>
              <div className="hidden sm:block text-left">
                <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                  {user?.name || 'Personal Cloud'}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">{user?.email || 'Your Files'}</p>
              </div>
              <ChevronDown
                className={`w-4 h-4 text-gray-500 dark:text-gray-400 transition-transform duration-300 ease-in-out ${
                  dropdownOpen ? 'rotate-180' : ''
                }`}
              />
            </button>

            {/* Dropdown Menu */}
            {dropdownOpen && (
              <>
                {/* Backdrop */}
                <div
                  className="fixed inset-0 z-40 bg-black/5 dark:bg-black/20 animate-fadeIn"
                  onClick={() => setDropdownOpen(false)}
                />
                {/* Dropdown */}
                <div className="absolute right-0 mt-2 w-48 bg-white/95 dark:bg-slate-800/95 backdrop-blur-xl rounded-xl shadow-2xl border border-gray-200/50 dark:border-slate-700/50 py-1 z-50 overflow-hidden animate-menuIn">
                  <button
                    onClick={() => {
                      logout();
                      setDropdownOpen(false);
                    }}
                    className="w-full flex items-center space-x-3 px-4 py-2.5 text-left text-gray-700 dark:text-gray-300 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-600 dark:hover:text-red-400 transition-all duration-200 group rounded-lg mx-1"
                  >
                    <LogOut className="w-4 h-4 transition-transform duration-200 group-hover:scale-110 group-hover:-translate-x-0.5" />
                    <span className="text-sm font-medium transition-colors duration-200">Log out</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
};
