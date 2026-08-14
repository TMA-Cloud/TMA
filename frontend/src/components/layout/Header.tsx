import React, { useState, useEffect, useRef } from 'react';
import { Menu, Search, Upload, LogOut, X, ChevronDown } from 'lucide-react';
import { useApp } from '../../contexts/AppContext';
import { useAuth } from '../../contexts/AuthContext';
import { ThemeToggle } from './ThemeToggle';

interface HeaderProps {
  /** Whether the page beneath has scrolled under the bar. */
  contentScrolled?: boolean;
}

export const Header: React.FC<HeaderProps> = ({ contentScrolled = false }) => {
  const { sidebarOpen, setSidebarOpen, setUploadModalOpen, searchQuery, setSearchQuery, isSearching } = useApp();
  const { logout, user, can } = useAuth();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

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

  const iconButton =
    'pressable grid place-items-center w-9 h-9 rounded-full text-[var(--label-secondary)] hover:bg-[var(--fill-quaternary)] hover:text-[var(--label)]';

  return (
    <header
      // A translucent layer the page passes beneath, not an opaque strip cut
      // out of it. The soft edge below appears only once content is actually
      // overlapping; a permanent rule would draw a boundary that is not there
      // most of the time.
      className="material-chrome scroll-edge sticky top-0 z-40 px-4 sm:px-6 py-2.5"
      data-scrolled={contentScrolled ? 'true' : 'false'}
    >
      <div className="flex items-center justify-between gap-4">
        {/* Left section */}
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <button onClick={() => setSidebarOpen(!sidebarOpen)} className={iconButton} aria-label="Open sidebar">
            <Menu className="w-[18px] h-[18px]" strokeWidth={2} />
          </button>

          {/* Search */}
          <div className="relative hidden md:block w-44 sm:w-72 lg:w-80 flex-1 max-w-md">
            <Search
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--label-tertiary)] pointer-events-none"
              strokeWidth={2}
            />
            <input
              type="text"
              placeholder="Search files and folders"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="type-callout w-full pl-9 pr-9 py-2 bg-[var(--fill-quaternary)] border border-transparent rounded-full text-[var(--label)] placeholder-[var(--label-tertiary)] focus:outline-none focus:bg-[var(--surface)] focus:border-[var(--accent-ring)] focus:ring-4 focus:ring-[var(--accent-fill)] transition-[background-color,border-color,box-shadow] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="pressable absolute right-2.5 top-1/2 -translate-y-1/2 grid place-items-center w-5 h-5 rounded-full bg-[var(--fill-tertiary)] text-[var(--label-secondary)] hover:bg-[var(--fill-secondary)] animate-scaleIn"
                aria-label="Clear search"
              >
                <X className="w-3 h-3" strokeWidth={3} />
              </button>
            )}
            {isSearching && searchQuery && (
              <div className="absolute right-9 top-1/2 -translate-y-1/2">
                <div className="w-3.5 h-3.5 border-2 border-[var(--fill-tertiary)] border-t-[var(--accent)] rounded-full animate-spin" />
              </div>
            )}
          </div>
        </div>

        {/* Right section */}
        <div className="flex items-center gap-1.5 sm:gap-2 flex-shrink-0">
          <ThemeToggle />
          {/* A sub-user without the upload grant is rejected by the server
              either way, so offering the button would only produce an error. */}
          {can('files.upload') && (
            <button
              onClick={() => setUploadModalOpen(true)}
              className="pressable type-callout type-emphasized flex items-center gap-2 pl-3.5 pr-4 py-2 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--label-on-accent)] rounded-full shadow-[var(--shadow-1)]"
            >
              <Upload className="w-4 h-4" strokeWidth={2.25} />
              <span className="hidden sm:inline">Upload</span>
            </button>
          )}

          {/* Profile Dropdown */}
          <div className="relative" ref={dropdownRef}>
            <button
              onClick={() => setDropdownOpen(!dropdownOpen)}
              className="pressable flex items-center gap-2 pl-1 pr-2 py-1 rounded-full hover:bg-[var(--fill-quaternary)]"
            >
              <div className="w-8 h-8 bg-[var(--accent)] rounded-full grid place-items-center text-[var(--label-on-accent)] type-caption type-emphasized">
                {getInitials(user?.name) || 'U'}
              </div>
              <div className="hidden sm:block text-left min-w-0">
                <p className="type-caption type-emphasized text-[var(--label)] truncate">
                  {user?.name || 'Personal Cloud'}
                </p>
                <p className="type-caption-2 text-[var(--label-tertiary)] truncate">{user?.email || 'Your Files'}</p>
              </div>
              <ChevronDown
                className={`w-3.5 h-3.5 text-[var(--label-tertiary)] transition-motion duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] flex-shrink-0 ${
                  dropdownOpen ? 'rotate-180' : ''
                }`}
                strokeWidth={2.5}
              />
            </button>

            {dropdownOpen && (
              <>
                {/* No scrim: this is a parallel choice, not a task that puts
                    the rest of the app on hold. */}
                <div className="fixed inset-0 z-40" onClick={() => setDropdownOpen(false)} />
                {/* Grown from the control that opened it, so the relationship
                    between button and menu is never in question. */}
                <div className="absolute right-0 mt-2 w-48 origin-top-right material-thick material-edge rounded-2xl p-1.5 z-50 animate-menuIn">
                  <button
                    onClick={() => {
                      logout();
                      setDropdownOpen(false);
                    }}
                    className="pressable type-callout w-full flex items-center gap-2.5 px-3 py-2 text-left text-[var(--label)] hover:bg-[var(--destructive)] hover:text-white rounded-xl"
                  >
                    <LogOut className="w-4 h-4 flex-shrink-0" strokeWidth={2} />
                    <span>Log out</span>
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
