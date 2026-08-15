import React, { useState, useEffect, useRef } from 'react';
import { useApp } from '../../contexts/AppContext';
import { useAuth } from '../../contexts/AuthContext';
import FileManager from '../fileManager/FileManager';
import Dashboard from '../dashboard/Dashboard';
import Settings from '../settings/Settings';
import { UploadModal } from '../upload/UploadModal';
import { UploadProgress } from '../upload/UploadProgress';
import { CreateFolderModal } from '../folder/CreateFolderModal';
import { ImageViewerModal } from '../viewer/ImageViewerModal';
import { DocumentViewerModal } from '../viewer/DocumentViewerModal';
import { useScrollEdge, scrollToTopFast } from '../../motion';
import { RenameModal } from '../fileManager/RenameModal';
import { ShareLinkModal } from '../fileManager/ShareLinkModal';
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
} from 'lucide-react';

const navItems = [
  { id: 'Dashboard', label: 'Home', icon: Home },
  { id: 'My Files', label: 'Files', icon: FolderOpen },
  { id: 'Shared', label: 'Shared', icon: Share2 },
  { id: 'Starred', label: 'Starred', icon: Star },
  { id: 'Trash', label: 'Trash', icon: Trash2 },
  { id: 'Settings', label: 'Settings', icon: SettingsIcon },
] as const;

export const MobileAppContent: React.FC = () => {
  const {
    currentPath,
    folderStack,
    setCurrentPath,
    setUploadModalOpen,
    uploadProgress,
    setUploadProgress,
    setIsUploadProgressInteracting,
  } = useApp();
  const { user, logout, can } = useAuth();
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const currentPage = currentPath[0];

  // Same hook as the desktop shell, so the top bar's edge and the overlay
  // scrollbar behave identically on both layouts.
  const { ref: mainRef, scrolled: contentScrolled } = useScrollEdge<HTMLElement>();
  const navScrollRef = useRef<{ page: string; stackLen: number }>({
    page: currentPath[0] ?? '',
    stackLen: folderStack.length,
  });

  // Scroll to top when changing top-level page or opening a deeper folder — not when going up (back/breadcrumb),
  // so the highlighted folder row stays visible like Windows Explorer.
  useEffect(() => {
    const page = currentPath[0] ?? '';
    const stackLen = folderStack.length;
    const prev = navScrollRef.current;
    const pageChanged = page !== prev.page;
    const wentDeeper = stackLen > prev.stackLen;
    navScrollRef.current = { page, stackLen };

    if (pageChanged || wentDeeper) {
      if (mainRef.current) {
        scrollToTopFast(mainRef.current, 180);
      }
    }
  }, [currentPath, folderStack.length, mainRef]);

  const renderContent = () => {
    switch (currentPage) {
      case 'Dashboard':
        return <Dashboard />;
      case 'Settings':
        return <Settings />;
      case 'My Files':
      case 'Shared':
      case 'Starred':
      case 'Trash':
      default:
        return <FileManager />;
    }
  };

  const handleNavClick = (id: (typeof navItems)[number]['id']) => {
    setCurrentPath([id]);
  };

  const getInitials = (name?: string | null) => {
    if (!name) return 'U';
    return name
      .split(' ')
      .map(n => n[0])
      .join('')
      .toUpperCase();
  };

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

  return (
    <div className="h-screen w-screen flex flex-col bg-[var(--canvas)]">
      {/* Backdrop - covers entire screen when dropdown is open */}
      {dropdownOpen && (
        <div
          className="fixed inset-0 bg-[var(--scrim)] animate-fadeIn z-[9998]"
          onClick={() => setDropdownOpen(false)}
        />
      )}

      {/* Compact top bar */}
      <header
        className="relative px-4 py-2.5 flex items-center justify-between material-chrome scroll-edge z-[9999]"
        data-scrolled={contentScrolled ? 'true' : 'false'}
      >
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-[10px] bg-[var(--accent)] grid place-items-center">
            <HardDrive className="w-4 h-4 text-[var(--label-on-accent)]" strokeWidth={2.25} />
          </div>
          <div className="flex flex-col">
            <span className="type-caption type-emphasized text-[var(--label)]">CloudStore</span>
            {/* Answers "where am I?" without spending a row on a title bar. */}
            <span className="type-caption-2 text-[var(--label-tertiary)]">{currentPage}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {can('files.upload') && (
            <button
              onClick={() => setUploadModalOpen(true)}
              className="pressable grid place-items-center rounded-full bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--label-on-accent)] w-9 h-9"
              aria-label="Upload"
            >
              <Upload className="w-4 h-4" strokeWidth={2.25} />
            </button>
          )}

          {/* Profile Dropdown */}
          <div className="relative z-[10000]" ref={dropdownRef}>
            <button
              onClick={() => setDropdownOpen(!dropdownOpen)}
              className="pressable flex items-center gap-1 rounded-full px-1 py-1 relative z-[10001]"
            >
              <div className="w-8 h-8 rounded-full bg-[var(--accent)] grid place-items-center type-caption-2 type-emphasized text-[var(--label-on-accent)]">
                {getInitials(user?.name)}
              </div>
              <ChevronDown
                className={`w-3 h-3 text-[var(--label-tertiary)] transition-motion duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                  dropdownOpen ? 'rotate-180' : ''
                }`}
                strokeWidth={2.5}
              />
            </button>

            {/* Dropdown Menu */}
            {dropdownOpen && (
              <div className="absolute right-0 mt-2 w-40 origin-top-right material-thick material-edge rounded-2xl p-1.5 z-[10002] animate-menuIn">
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
            )}
          </div>
        </div>
      </header>

      {/* Main content */}
      <main ref={mainRef} className="scroller flex-1 overflow-y-auto px-3 pt-3 pb-16">
        <div className="animate-fadeIn">{renderContent()}</div>
      </main>

      {/* Bottom navigation — the tab bar is chrome the content scrolls under,
          and the safe-area inset keeps it clear of the home indicator. */}
      <nav
        className="fixed bottom-0 left-0 right-0 z-40 material-chrome material-edge-top"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        <div className="flex justify-around py-1 px-1">
          {navItems.map(item => {
            const Icon = item.icon;
            const active = currentPage === item.id;
            return (
              <button
                key={item.id}
                onClick={() => handleNavClick(item.id)}
                className="pressable flex flex-col items-center gap-0.5 flex-1 px-1 py-1.5 rounded-xl"
                aria-current={active ? 'page' : undefined}
              >
                {/* Fill and label change together, so selection reads as one
                    state rather than two independent highlights. */}
                <div
                  className={`grid place-items-center w-9 h-7 rounded-full transition-colors duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                    active ? 'bg-[var(--accent-fill)] text-[var(--accent)]' : 'text-[var(--label-tertiary)]'
                  }`}
                >
                  <Icon className="w-[18px] h-[18px]" strokeWidth={active ? 2.25 : 2} />
                </div>
                <span
                  className={`type-caption-2 ${
                    active ? 'type-emphasized text-[var(--accent)]' : 'text-[var(--label-tertiary)]'
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
        onDismiss={id => {
          setUploadProgress(prev => prev.filter(item => item.id !== id));
        }}
        onInteractionChange={setIsUploadProgressInteracting}
      />
    </div>
  );
};

export default MobileAppContent;
