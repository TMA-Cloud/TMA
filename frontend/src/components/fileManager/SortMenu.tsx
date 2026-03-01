import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SortAsc, Check } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';

interface SortMenuProps {
  sortBy: string;
  sortOrder: 'asc' | 'desc';
  onSortChange: (by: string, order: 'asc' | 'desc') => void;
}

const sortOptions = [
  { label: 'Name (A-Z)', by: 'name', order: 'asc' as const },
  { label: 'Name (Z-A)', by: 'name', order: 'desc' as const },
  { label: 'Modified (newest)', by: 'modified', order: 'desc' as const },
  { label: 'Modified (oldest)', by: 'modified', order: 'asc' as const },
  { label: 'Size (largest)', by: 'size', order: 'desc' as const },
  { label: 'Size (smallest)', by: 'size', order: 'asc' as const },
] as const;

export const SortMenu: React.FC<SortMenuProps> = ({ sortBy, sortOrder, onSortChange }) => {
  const [showSortMenu, setShowSortMenu] = useState(false);
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const sortButtonRef = useRef<HTMLButtonElement>(null);
  const [sortMenuPos, setSortMenuPos] = useState({ top: 0, right: 0 });

  useEffect(() => {
    if (!showSortMenu) return;
    const handler = (e: MouseEvent) => {
      if (sortMenuRef.current && !sortMenuRef.current.contains(e.target as Node)) {
        setShowSortMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showSortMenu]);

  return (
    <div className="relative">
      <Tooltip text="Sort">
        <button
          ref={sortButtonRef}
          className="p-2.5 rounded-2xl text-slate-500 dark:text-slate-400 hover:text-violet-500 dark:hover:text-violet-400 transition-all duration-300 ease-out hover-lift hover:bg-violet-500/10 dark:hover:bg-violet-500/20"
          aria-label="Sort"
          onClick={() => {
            if (!showSortMenu && sortButtonRef.current) {
              const rect = sortButtonRef.current.getBoundingClientRect();
              setSortMenuPos({
                top: rect.bottom + 8,
                right: window.innerWidth - rect.right,
              });
            }
            setShowSortMenu(s => !s);
          }}
        >
          <SortAsc className="w-5 h-5 transition-transform duration-200 icon-muted" />
        </button>
      </Tooltip>
      {showSortMenu &&
        createPortal(
          <>
            {/* Overlay */}
            <div
              className="fixed inset-0 bg-black/5 dark:bg-black/20 backdrop-blur-sm transition-opacity duration-200 ease-in-out animate-fadeIn z-[9998]"
              onClick={() => setShowSortMenu(false)}
            />
            {/* Sort menu */}
            <div
              ref={sortMenuRef}
              className="fixed w-48 bg-[#f0f3f7]/98 dark:bg-slate-800/98 backdrop-blur-xl border border-slate-200/60 dark:border-slate-700/50 rounded-2xl shadow-soft-lg z-[9999] animate-menuIn"
              style={{
                top: `${sortMenuPos.top}px`,
                right: `${sortMenuPos.right}px`,
              }}
              onMouseDown={e => e.stopPropagation()}
              onClick={e => e.stopPropagation()}
            >
              {sortOptions.map(opt => (
                <button
                  key={opt.label}
                  onClick={() => {
                    onSortChange(opt.by, opt.order);
                    setShowSortMenu(false);
                  }}
                  className={`flex items-center w-full px-4 py-2.5 text-sm text-left transition-all duration-300 ease-out rounded-xl mx-1.5 ${
                    sortBy === opt.by && sortOrder === opt.order
                      ? 'bg-[#5b8def]/15 dark:bg-[#5b8def]/25 text-[#4a7edb] dark:text-blue-300 font-semibold'
                      : 'text-slate-700 dark:text-slate-300 hover:bg-slate-200/50 dark:hover:bg-slate-700/50'
                  }`}
                >
                  {sortBy === opt.by && sortOrder === opt.order && <Check className="w-4 h-4 mr-2" />}
                  {!(sortBy === opt.by && sortOrder === opt.order) && <span className="w-4 h-4 mr-2" />}
                  {opt.label}
                </button>
              ))}
            </div>
          </>,
          document.body
        )}
    </div>
  );
};
