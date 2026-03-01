import React, { useState, useEffect, useRef } from 'react';
import { Menu, Search, Upload, LogOut, X, ChevronDown } from 'lucide-react';
import { useApp } from '../../contexts/AppContext';
import { useAuth } from '../../contexts/AuthContext';
import { ThemeToggle } from './ThemeToggle';

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
      className={`bg-[#f0f3f7]/90 dark:bg-slate-900/90 border-b border-slate-200/70 dark:border-slate-800/70 backdrop-blur-xl px-4 sm:px-6 py-3 transition-all duration-300 sticky top-0 z-40 ${scrolled ? 'shadow-soft' : ''}`}
    >
      <div className="flex items-center justify-between gap-4">
        {/* Left section */}
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="ripple p-2 rounded-2xl text-slate-500 hover:text-[#4a7edb] dark:hover:text-blue-400 hover:bg-slate-200/50 dark:hover:bg-slate-700/50 transition-all duration-300 ease-out focus:outline-none focus:ring-2 focus:ring-[#5b8def]/40 active:scale-95 flex-shrink-0"
            aria-label="Open sidebar"
          >
            <Menu className="w-5 h-5" />
          </button>

          {/* Search */}
          <div className="relative hidden md:block w-44 sm:w-72 lg:w-80 flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none transition-colors duration-300" />
            <input
              type="text"
              placeholder="Search files and folders..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-9 py-2.5 bg-slate-100/80 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/60 rounded-2xl focus:outline-none focus:ring-2 focus:ring-[#5b8def]/35 focus:border-[#5b8def]/40 text-slate-800 dark:text-slate-100 placeholder-slate-400 transition-all duration-300 ease-out text-sm"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1.5 rounded-xl hover:bg-slate-200/60 dark:hover:bg-slate-600/50 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-all duration-300 ease-out animate-scaleIn"
                aria-label="Clear search"
              >
                <X className="w-4 h-4" />
              </button>
            )}
            {isSearching && searchQuery && (
              <div className="absolute right-9 top-1/2 -translate-y-1/2">
                <div className="w-4 h-4 border-2 border-slate-300 dark:border-slate-600 border-t-[#5b8def] dark:border-t-blue-400 rounded-full animate-spin" />
              </div>
            )}
          </div>
        </div>

        {/* Right section */}
        <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
          <ThemeToggle />
          <button
            onClick={() => setUploadModalOpen(true)}
            className="ripple btn-glow flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-[#5b8def] to-[#4a7edb] hover:from-[#4a7edb] hover:to-[#3d6ec7] text-white rounded-2xl shadow-soft focus:outline-none focus:ring-2 focus:ring-[#5b8def]/40 hover-lift font-semibold text-sm transition-all duration-300 ease-out"
          >
            <Upload className="w-4 h-4" />
            <span className="hidden sm:inline">Upload</span>
          </button>

          {/* Profile Dropdown */}
          <div className="relative" ref={dropdownRef}>
            <button
              onClick={() => setDropdownOpen(!dropdownOpen)}
              className="flex items-center gap-2 p-2 rounded-2xl hover:bg-slate-200/50 dark:hover:bg-slate-700/50 cursor-pointer transition-all duration-300 ease-out focus:outline-none focus:ring-2 focus:ring-[#5b8def]/40"
            >
              <div className="w-8 h-8 bg-gradient-to-br from-[#5b8def] to-[#4a7edb] rounded-full flex items-center justify-center shadow-soft text-white font-semibold text-sm transition-all duration-300 ease-out">
                {getInitials(user?.name) || 'U'}
              </div>
              <div className="hidden sm:block text-left min-w-0">
                <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">
                  {user?.name || 'Personal Cloud'}
                </p>
                <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{user?.email || 'Your Files'}</p>
              </div>
              <ChevronDown
                className={`w-4 h-4 text-slate-500 dark:text-slate-400 transition-transform duration-300 ease-out flex-shrink-0 ${dropdownOpen ? 'rotate-180' : ''}`}
              />
            </button>

            {dropdownOpen && (
              <>
                <div
                  className="fixed inset-0 z-40 bg-slate-900/10 dark:bg-black/15 backdrop-blur-[2px] animate-fadeIn"
                  onClick={() => setDropdownOpen(false)}
                />
                <div className="absolute right-0 mt-2 w-48 bg-[#f0f3f7]/98 dark:bg-slate-800/98 backdrop-blur-xl rounded-2xl shadow-soft-lg border border-slate-200/60 dark:border-slate-700/60 py-1.5 z-50 overflow-hidden animate-menuIn">
                  <button
                    onClick={() => {
                      logout();
                      setDropdownOpen(false);
                    }}
                    className="w-full flex items-center gap-3 px-4 py-2.5 text-left text-slate-700 dark:text-slate-300 hover:bg-red-50/80 dark:hover:bg-red-900/20 hover:text-red-600 dark:hover:text-red-400 transition-all duration-300 ease-out rounded-xl mx-1.5 group"
                  >
                    <LogOut className="w-4 h-4 flex-shrink-0 transition-transform duration-300 group-hover:-translate-x-0.5" />
                    <span className="text-sm font-medium">Log out</span>
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
