import React, { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import {
  Home,
  FolderOpen,
  Share2,
  Star,
  Trash2,
  Settings,
  HardDrive,
  X,
  Download,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { useApp } from '../../contexts/AppContext';
import { isElectron } from '../../utils/electronDesktop';
import { SPRING_PRESETS, useSpring } from '../../motion';

// Named for what they contain rather than for a vague umbrella: a specific
// label is what makes a destination predictable before you get there.
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
  const {
    currentPath,
    setCurrentPath,
    sidebarOpen,
    setSidebarOpen,
    updatesAvailable,
    electronAutoUpdateState,
    retryElectronUpdate,
  } = useApp();

  const indicatorRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const placed = useRef(false);

  // The selection is one object that travels between rows, not a fill that
  // blinks out of one and into another. A spring drives it so running quickly
  // down the list redirects the pill mid-flight instead of queueing up moves.
  const indicatorY = useSpring(0, SPRING_PRESETS.move);
  const indicatorHeight = useSpring(0, SPRING_PRESETS.move);

  const handleNavigation = (path: string[]) => {
    setCurrentPath(path);
    if (window.innerWidth < 768) {
      setSidebarOpen(false);
    }
  };

  const isActive = useCallback((path: string[]) => currentPath[0] === path[0], [currentPath]);

  const registerItem = useCallback((id: string, node: HTMLButtonElement | null) => {
    if (node) itemRefs.current.set(id, node);
    else itemRefs.current.delete(id);
  }, []);

  useEffect(() => {
    const write = () => {
      const element = indicatorRef.current;
      if (!element) return;
      element.style.transform = `translate3d(0, ${indicatorY.current}px, 0)`;
      element.style.height = `${indicatorHeight.current}px`;
    };
    const unsubY = indicatorY.subscribe(write);
    const unsubH = indicatorHeight.subscribe(write);
    return () => {
      unsubY();
      unsubH();
    };
  }, [indicatorY, indicatorHeight]);

  useLayoutEffect(() => {
    const active = navigationItems.find(item => isActive(item.path));
    const node = active ? itemRefs.current.get(active.id) : undefined;
    const indicator = indicatorRef.current;
    if (!indicator) return;

    if (!node) {
      // Settings lives outside this list, so the travelling pill has nowhere
      // to go; it steps aside rather than sliding to a row nobody picked.
      indicator.style.opacity = '0';
      return;
    }

    indicator.style.opacity = '1';

    if (!placed.current) {
      // Nothing has been on screen yet, so there is no motion to inherit —
      // place it rather than animating in from an arbitrary zero.
      indicatorY.jump(node.offsetTop);
      indicatorHeight.jump(node.offsetHeight);
      placed.current = true;
      return;
    }

    indicatorY.setTarget(node.offsetTop);
    indicatorHeight.setTarget(node.offsetHeight);
  }, [currentPath, isActive, indicatorY, indicatorHeight]);

  const navButton = (active: boolean) =>
    `pressable-lg type-callout relative z-10 w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left
     ${active ? 'type-emphasized text-[var(--accent)]' : 'text-[var(--label-secondary)] hover:text-[var(--label)]'}`;

  return (
    <>
      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-[var(--scrim)] lg:hidden animate-fadeIn"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div
        className={`
        fixed lg:static inset-y-0 left-0 z-50 w-64 material-chrome
        border-r border-[var(--separator)]
        transition-motion duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]
        ${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
        ${!sidebarOpen ? 'lg:w-0 lg:overflow-hidden' : ''}
      `}
      >
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="px-4 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 bg-[var(--accent)] rounded-[10px] grid place-items-center">
                  <HardDrive className="w-4 h-4 text-[var(--label-on-accent)]" strokeWidth={2.25} />
                </div>
                <span className="type-title-3 text-[var(--label)]">CloudStore</span>
              </div>
              <button
                onClick={() => setSidebarOpen(false)}
                className="pressable lg:hidden grid place-items-center w-8 h-8 rounded-full text-[var(--label-secondary)] hover:bg-[var(--fill-quaternary)] hover:text-[var(--label)]"
                aria-label="Close sidebar"
              >
                <X className="w-4 h-4" strokeWidth={2.25} />
              </button>
            </div>
          </div>

          {/* Navigation */}
          <nav className="relative flex-1 flex flex-col gap-0.5 px-3">
            <div
              ref={indicatorRef}
              aria-hidden="true"
              className="absolute inset-x-3 rounded-xl bg-[var(--accent-fill)] transition-opacity duration-200 pointer-events-none"
              style={{ willChange: 'transform, height' }}
            />
            {navigationItems.map(item => {
              const Icon = item.icon;
              const active = isActive(item.path);

              return (
                <button
                  key={item.id}
                  ref={node => registerItem(item.id, node)}
                  onClick={() => handleNavigation(item.path)}
                  className={navButton(active)}
                  aria-current={active ? 'page' : undefined}
                >
                  <Icon
                    className={`w-[18px] h-[18px] flex-shrink-0 ${active ? 'text-[var(--accent)]' : 'text-[var(--label-tertiary)]'}`}
                    strokeWidth={2}
                  />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </nav>

          {/* Updates banner */}
          {updatesAvailable && (
            <div className="px-3 pb-2">
              <div className="rounded-xl border border-[var(--separator)] bg-[var(--fill-quaternary)] px-3 py-2.5">
                <p className="type-caption type-emphasized text-[var(--warning-text)] mb-1">Updates available</p>
                <ul className="type-caption text-[var(--label-secondary)] space-y-0.5">
                  {updatesAvailable.backend && <li>Backend → {updatesAvailable.backend}</li>}
                  {updatesAvailable.frontend && <li>Frontend → {updatesAvailable.frontend}</li>}
                  {updatesAvailable.electron && (
                    <li className="flex flex-col gap-1">
                      <span>Desktop → {updatesAvailable.electron}</span>
                      {isElectron() && electronAutoUpdateState.status !== 'idle' && (
                        <div className="flex flex-col gap-1">
                          {electronAutoUpdateState.status === 'downloading' && (
                            <div className="flex items-center gap-1.5">
                              <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" />
                              <span>
                                Auto-updating
                                {electronAutoUpdateState.progress != null
                                  ? ` ${electronAutoUpdateState.progress}%`
                                  : '…'}
                              </span>
                            </div>
                          )}
                          {electronAutoUpdateState.status === 'downloading' &&
                            electronAutoUpdateState.progress != null && (
                              <div className="h-1 w-full rounded-full bg-[var(--fill-tertiary)] overflow-hidden">
                                <div
                                  className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
                                  style={{ width: `${electronAutoUpdateState.progress}%` }}
                                />
                              </div>
                            )}
                          {electronAutoUpdateState.status === 'installing' && (
                            <div className="flex items-center gap-1.5">
                              <Download className="w-3 h-3 flex-shrink-0" />
                              <span>Installing… the app will restart</span>
                            </div>
                          )}
                          {electronAutoUpdateState.status === 'error' && (
                            <button
                              type="button"
                              onClick={() => void retryElectronUpdate()}
                              className="inline-flex items-center gap-1.5 text-[var(--destructive-text)] hover:underline rounded-sm"
                              aria-label="Retry desktop update"
                            >
                              <RefreshCw className="w-3 h-3 flex-shrink-0" />
                              <span>{electronAutoUpdateState.error || 'Update failed'} (Retry)</span>
                            </button>
                          )}
                        </div>
                      )}
                    </li>
                  )}
                </ul>
              </div>
            </div>
          )}

          {/* Settings */}
          <div className="p-3 border-t border-[var(--separator)]">
            <button
              onClick={() => handleNavigation(['Settings'])}
              className={`${navButton(isActive(['Settings']))} ${
                isActive(['Settings']) ? 'bg-[var(--accent-fill)]' : 'hover:bg-[var(--fill-quaternary)]'
              }`}
              aria-current={isActive(['Settings']) ? 'page' : undefined}
            >
              <Settings
                className={`w-[18px] h-[18px] flex-shrink-0 ${
                  isActive(['Settings']) ? 'text-[var(--accent)]' : 'text-[var(--label-tertiary)]'
                }`}
                strokeWidth={2}
              />
              <span>Settings</span>
            </button>
          </div>
        </div>
      </div>
    </>
  );
};
