import React from 'react';
import { Home, FolderOpen, Share2, Star, Trash2, Settings, HardDrive, X } from 'lucide-react';
import { useApp } from '../../contexts/AppContext';

const navigationItems = [
  { id: 'dashboard', label: 'Dashboard', icon: Home, path: ['Dashboard'] },
  { id: 'files', label: 'My Files', icon: FolderOpen, path: ['My Files'] },
  {
    id: 'shared',
    label: 'Shared',
    icon: Share2,
    path: ['Shared'],
  },
  { id: 'starred', label: 'Starred', icon: Star, path: ['Starred'] },
  { id: 'trash', label: 'Trash', icon: Trash2, path: ['Trash'] },
];

export const Sidebar: React.FC = () => {
  const { currentPath, setCurrentPath, sidebarOpen, setSidebarOpen, updatesAvailable } = useApp();

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
          className="fixed inset-0 z-40 bg-slate-900/30 backdrop-blur-[2px] lg:hidden transition-opacity duration-300 animate-fadeIn"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div
        className={`
        fixed lg:static inset-y-0 left-0 z-50 w-64 bg-[#f0f3f7]/95 dark:bg-slate-900/95 backdrop-blur-xl
        border-r border-slate-200/80 dark:border-slate-800/80 shadow-soft lg:shadow-none rounded-r-2xl lg:rounded-none
        transform transition-all duration-300 ease-out
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        ${!sidebarOpen ? 'lg:w-0 lg:overflow-hidden' : ''}
      `}
      >
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="p-5 border-b border-slate-200/60 dark:border-slate-800/60">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5 animate-slideDown">
                <div className="w-9 h-9 bg-gradient-to-br from-[#5b8def] to-[#4a7edb] rounded-xl flex items-center justify-center shadow-soft transition-all duration-300 ease-out hover:shadow-soft-md">
                  <HardDrive className="w-5 h-5 text-white" />
                </div>
                <span className="text-xl font-bold text-slate-800 dark:text-slate-100 tracking-tight">CloudStore</span>
              </div>
              <button
                onClick={() => setSidebarOpen(false)}
                className="lg:hidden p-2 rounded-xl text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 hover:bg-slate-200/60 dark:hover:bg-slate-700/50 transition-all duration-300 ease-out focus:outline-none focus:ring-2 focus:ring-[#5b8def]/40 active:scale-95"
                aria-label="Close sidebar"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Navigation */}
          <nav className="flex-1 flex flex-col gap-1 p-3">
            {navigationItems.map(item => {
              const Icon = item.icon;
              const active = isActive(item.path);

              return (
                <button
                  key={item.id}
                  onClick={() => handleNavigation(item.path)}
                  className={`
                    group stagger-item ripple w-full flex items-center gap-3 px-3.5 py-3 rounded-2xl text-left relative
                    transition-all duration-300 ease-out
                    focus:outline-none focus:ring-2 focus:ring-[#5b8def]/40 focus:ring-offset-2 focus:ring-offset-transparent
                    ${
                      active
                        ? 'bg-[#5b8def]/12 dark:bg-[#5b8def]/20 text-[#4a7edb] dark:text-blue-300 font-semibold'
                        : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200/50 dark:hover:bg-slate-700/40 hover:text-slate-800 dark:hover:text-slate-100'
                    }
                  `}
                  aria-current={active ? 'page' : undefined}
                >
                  <Icon
                    className={`w-5 h-5 flex-shrink-0 relative z-10 transition-all duration-300 ease-out ${
                      active
                        ? 'text-[#4a7edb] dark:text-blue-400'
                        : 'text-slate-500 dark:text-slate-400 group-hover:text-slate-700 dark:group-hover:text-slate-200'
                    }`}
                  />
                  <span className="relative z-10 truncate">{item.label}</span>
                </button>
              );
            })}
          </nav>

          {/* Updates banner (admin only) */}
          {updatesAvailable && (
            <div className="px-3 pb-2">
              <div className="rounded-2xl border border-amber-300/50 dark:border-amber-600/30 bg-amber-50/80 dark:bg-amber-900/15 px-3.5 py-2.5 shadow-soft">
                <p className="text-xs font-semibold text-amber-800 dark:text-amber-200 mb-1">Updates Available</p>
                <ul className="text-xs text-amber-700 dark:text-amber-100/90 space-y-0.5">
                  {updatesAvailable.backend && <li>Backend ⟶ {updatesAvailable.backend}</li>}
                  {updatesAvailable.frontend && <li>Frontend ⟶ {updatesAvailable.frontend}</li>}
                  {updatesAvailable.electron && <li>Electron ⟶ {updatesAvailable.electron}</li>}
                </ul>
              </div>
            </div>
          )}

          {/* Settings */}
          <div className="p-3 border-t border-slate-200/60 dark:border-slate-800/60">
            <button
              onClick={() => handleNavigation(['Settings'])}
              className={`
                group ripple w-full flex items-center gap-3 px-3.5 py-3 rounded-2xl text-left relative
                transition-all duration-300 ease-out
                focus:outline-none focus:ring-2 focus:ring-[#5b8def]/40 focus:ring-offset-2 focus:ring-offset-transparent
                ${
                  isActive(['Settings'])
                    ? 'bg-[#5b8def]/12 dark:bg-[#5b8def]/20 text-[#4a7edb] dark:text-blue-300 font-semibold'
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200/50 dark:hover:bg-slate-700/40 hover:text-slate-800 dark:hover:text-slate-100'
                }
              `}
              aria-current={isActive(['Settings']) ? 'page' : undefined}
            >
              <Settings
                className={`w-5 h-5 flex-shrink-0 relative z-10 transition-all duration-300 ease-out ${
                  isActive(['Settings'])
                    ? 'text-[#4a7edb] dark:text-blue-400'
                    : 'text-slate-500 dark:text-slate-400 group-hover:text-slate-700 dark:group-hover:text-slate-200'
                }`}
              />
              <span className="relative z-10">Settings</span>
            </button>
          </div>
        </div>
      </div>
    </>
  );
};
