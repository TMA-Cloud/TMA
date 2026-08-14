import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpDown, Check } from 'lucide-react';
import { Tooltip } from '../ui/Tooltip';

interface SortMenuProps {
  sortBy: string;
  sortOrder: 'asc' | 'desc';
  onSortChange: (by: string, order: 'asc' | 'desc') => void;
}

const sortOptions = [
  { label: 'Name (A–Z)', by: 'name', order: 'asc' as const },
  { label: 'Name (Z–A)', by: 'name', order: 'desc' as const },
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
          className={`pressable grid place-items-center w-9 h-9 rounded-full ${
            showSortMenu
              ? 'text-[var(--accent)] bg-[var(--accent-fill)]'
              : 'text-[var(--label-secondary)] hover:bg-[var(--fill-quaternary)] hover:text-[var(--label)]'
          }`}
          aria-label="Sort"
          aria-expanded={showSortMenu}
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
          <ArrowUpDown className="w-[18px] h-[18px]" strokeWidth={2} />
        </button>
      </Tooltip>
      {showSortMenu &&
        createPortal(
          <>
            {/* Choosing a sort order does not put the rest of the app on hold,
                so the layer that catches the outside click stays invisible. */}
            <div className="fixed inset-0 z-[9998]" onClick={() => setShowSortMenu(false)} />
            {/* Anchored to the top-right so it appears to grow out of the
                button that opened it. */}
            <div
              ref={sortMenuRef}
              className="fixed w-52 origin-top-right material-thick material-edge rounded-2xl p-1.5 z-[9999] animate-menuIn"
              style={{
                top: `${sortMenuPos.top}px`,
                right: `${sortMenuPos.right}px`,
              }}
              onMouseDown={e => e.stopPropagation()}
              onClick={e => e.stopPropagation()}
            >
              {sortOptions.map(opt => {
                const selected = sortBy === opt.by && sortOrder === opt.order;
                return (
                  <button
                    key={opt.label}
                    onClick={() => {
                      onSortChange(opt.by, opt.order);
                      setShowSortMenu(false);
                    }}
                    className={`pressable type-callout flex items-center gap-2 w-full px-2.5 py-2 text-left rounded-xl ${
                      selected
                        ? 'type-emphasized text-[var(--accent)] bg-[var(--accent-fill)]'
                        : 'text-[var(--label)] hover:bg-[var(--fill-quaternary)]'
                    }`}
                  >
                    <Check
                      className={`w-3.5 h-3.5 flex-shrink-0 ${selected ? 'opacity-100' : 'opacity-0'}`}
                      strokeWidth={3}
                    />
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </>,
          document.body
        )}
    </div>
  );
};
