import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, Home } from 'lucide-react';
import { useApp } from '../../contexts/AppContext';
import { useIsMobile } from '../../hooks/useIsMobile';

// Shared class strings so the off-screen measuring row is a pixel-for-pixel twin
// of the row the user sees. If these drift apart, the width math lies and crumbs
// collapse too early or too late.
const CHEVRON_CLASS = 'w-5 h-5 text-slate-400 dark:text-slate-500 flex-shrink-0';
const CRUMB_BASE = 'inline-flex items-center max-w-[11rem] py-1.5 px-2 rounded-xl transition-all duration-300 ease-out';

/** A single leading chevron + label unit, used verbatim by the live and ghost rows. */
const chevron = <ChevronRight className={CHEVRON_CLASS} aria-hidden />;

interface HiddenItem {
  label: string;
  index: number;
}

/**
 * The "…" control and the menu of collapsed ancestors it opens. The hidden folders
 * stay one click away instead of disappearing.
 */
const OverflowMenu: React.FC<{ items: HiddenItem[]; onNavigate: (index: number) => void }> = ({
  items,
  onNavigate,
}) => {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="relative flex items-center flex-shrink-0">
      {chevron}
      <button
        ref={buttonRef}
        type="button"
        aria-label="Show hidden folders"
        aria-expanded={open}
        onClick={() => {
          if (!open && buttonRef.current) {
            const rect = buttonRef.current.getBoundingClientRect();
            setPos({ top: rect.bottom + 8, left: rect.left });
          }
          setOpen(o => !o);
        }}
        className={`${CRUMB_BASE} px-2.5 leading-none ${
          open
            ? 'text-slate-800 dark:text-slate-100 bg-slate-200/60 dark:bg-slate-700/60'
            : 'text-slate-500 dark:text-slate-400 hover:bg-slate-200/50 dark:hover:bg-slate-700/50 hover:text-slate-800 dark:hover:text-slate-100'
        }`}
      >
        <span className="tracking-widest -mt-1">…</span>
      </button>

      {open &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[9998]" onClick={() => setOpen(false)} />
            <div
              ref={menuRef}
              className="fixed min-w-[11rem] max-w-[18rem] material-thick material-edge rounded-2xl p-1.5 z-[9999] animate-menuIn"
              style={{ top: `${pos.top}px`, left: `${pos.left}px` }}
              onMouseDown={e => e.stopPropagation()}
            >
              {items.map(item => (
                <button
                  key={item.index}
                  onClick={() => {
                    onNavigate(item.index);
                    setOpen(false);
                  }}
                  className="pressable type-callout flex items-center gap-2 w-full px-2.5 py-2 text-left rounded-xl text-[var(--label)] hover:bg-[var(--fill-quaternary)]"
                >
                  <ChevronRight className="w-3.5 h-3.5 flex-shrink-0 opacity-40" strokeWidth={2.5} />
                  <span className="truncate">{item.label}</span>
                </button>
              ))}
            </div>
          </>,
          document.body
        )}
    </div>
  );
};

export const Breadcrumbs: React.FC = () => {
  const { currentPath, navigateTo, setCurrentPath } = useApp();
  const isMobile = useIsMobile();

  const navRef = useRef<HTMLElement>(null);
  const homeRef = useRef<HTMLSpanElement>(null);
  const overflowRef = useRef<HTMLSpanElement>(null);
  const segRefs = useRef<(HTMLSpanElement | null)[]>([]);
  // Index of the first path segment kept visible and everything before it folds into "…".
  const [firstVisible, setFirstVisible] = useState(0);

  const homeButton = (
    <button
      onClick={() => setCurrentPath(['My Files'], [null])}
      aria-label="My Files"
      className={`flex items-center justify-center min-w-[2.25rem] min-h-[2.25rem] rounded-xl flex-shrink-0 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-100 hover:bg-slate-200/50 dark:hover:bg-slate-700/50 transition-all duration-300 ease-out`}
    >
      <Home className="w-5 h-5" strokeWidth={2} />
    </button>
  );

  const crumbButton = (label: string, actualIndex: number, isLast: boolean) => (
    <button
      onClick={() => navigateTo(actualIndex)}
      title={label}
      className={`${CRUMB_BASE} hover:bg-slate-200/50 dark:hover:bg-slate-700/50 hover:text-slate-800 dark:hover:text-slate-100 ${
        isLast ? 'text-slate-800 dark:text-slate-100 font-semibold' : 'text-slate-500 dark:text-slate-400'
      }`}
    >
      <span className="truncate">{label}</span>
    </button>
  );

  // Greedy fit, measured against the space the flex row actually has right now.
  // Keep the current folder always; add ancestors from the tail inward while they
  // fit; fold the rest into "…". Because the nav is `flex-1 min-w-0`, this width
  // shrinks the moment the toolbar sprouts selection icons, and the observer below
  // re-runs the fit — so the trail gives ground instead of colliding.
  const recompute = useCallback(() => {
    const nav = navRef.current;
    if (!nav || isMobile) return;
    const avail = nav.clientWidth;
    const homeW = homeRef.current?.offsetWidth ?? 0;
    const overflowW = overflowRef.current?.offsetWidth ?? 0;
    const widths = currentPath.map((_, i) => segRefs.current[i]?.offsetWidth ?? 0);
    const last = currentPath.length - 1;

    const totalAll = homeW + widths.reduce((a, b) => a + b, 0);
    if (last < 1 || totalAll <= avail) {
      setFirstVisible(0);
      return;
    }

    let used = homeW + overflowW + (widths[last] ?? 0);
    let first = last;
    for (let i = last - 1; i >= 1; i--) {
      const w = widths[i] ?? 0;
      if (used + w <= avail) {
        used += w;
        first = i;
      } else {
        break;
      }
    }
    setFirstVisible(first);
  }, [currentPath, isMobile]);

  useLayoutEffect(() => {
    recompute();
  }, [recompute]);

  useEffect(() => {
    const nav = navRef.current;
    if (!nav || isMobile) return;
    const ro = new ResizeObserver(() => recompute());
    ro.observe(nav);
    return () => ro.disconnect();
  }, [recompute, isMobile]);

  // Mobile: the row scrolls horizontally, so it can never overlap. Show the
  // last two segments inline and hand the rest to the same "…" menu so deep
  // ancestors stay reachable instead of vanishing.
  if (isMobile) {
    const truncate = currentPath.length > 2;
    const tail = truncate ? currentPath.slice(-2) : currentPath;
    const tailStart = truncate ? currentPath.length - 2 : 0;
    const hidden: HiddenItem[] = truncate
      ? currentPath.slice(0, currentPath.length - 2).map((label, index) => ({ label, index }))
      : [];

    return (
      <nav
        aria-label="Breadcrumb"
        className="flex items-center overflow-x-auto scrollbar-hide flex-1 min-w-0 text-base min-h-10"
      >
        {homeButton}
        {truncate && <OverflowMenu items={hidden} onNavigate={navigateTo} />}
        {tail.map((segment, i) => {
          const actualIndex = tailStart + i;
          return (
            <React.Fragment key={actualIndex}>
              {chevron}
              <span className="flex-shrink-0 whitespace-nowrap">
                {crumbButton(segment, actualIndex, actualIndex === currentPath.length - 1)}
              </span>
            </React.Fragment>
          );
        })}
      </nav>
    );
  }

  // Desktop: width-measured collapse.
  const collapsed = firstVisible > 0;
  const hidden: HiddenItem[] = currentPath.slice(0, firstVisible).map((label, index) => ({ label, index }));

  return (
    <nav
      ref={navRef}
      aria-label="Breadcrumb"
      className="relative flex items-center flex-nowrap overflow-hidden text-base min-h-10"
    >
      {homeButton}

      {collapsed && <OverflowMenu items={hidden} onNavigate={navigateTo} />}

      {currentPath.slice(firstVisible).map((segment, i) => {
        const actualIndex = firstVisible + i;
        return (
          <React.Fragment key={actualIndex}>
            {chevron}
            {crumbButton(segment, actualIndex, actualIndex === currentPath.length - 1)}
          </React.Fragment>
        );
      })}

      {/* Off-screen measuring twin: natural widths of every crumb at full length,
          so recompute knows what would fit before committing anything to screen.
          Invisible and inert, but offsetWidth is still real. */}
      <div
        aria-hidden
        className="absolute left-0 top-0 flex items-center flex-nowrap whitespace-nowrap invisible pointer-events-none"
      >
        <span ref={homeRef} className="inline-flex">
          {homeButton}
        </span>
        <span ref={overflowRef} className="inline-flex items-center">
          {chevron}
          <span className={`${CRUMB_BASE} px-2.5`}>…</span>
        </span>
        {currentPath.map((segment, i) => (
          <span
            key={i}
            ref={el => {
              segRefs.current[i] = el;
            }}
            className="inline-flex items-center"
          >
            {chevron}
            <span className={CRUMB_BASE}>
              <span className="truncate">{segment}</span>
            </span>
          </span>
        ))}
      </div>
    </nav>
  );
};
