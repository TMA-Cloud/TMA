import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ContextMenuItem } from './useContextMenuActions';

interface ContextMenuNavigationParams {
  isOpen: boolean;
  isMobile: boolean;
  position: { x: number; y: number };
  menuItems: ContextMenuItem[];
  onClose: () => void;
}

/** Desktop context-menu placement (clamped to the viewport) and arrow/enter/escape/click-outside. */
export function useContextMenuNavigation({
  isOpen,
  isMobile,
  position,
  menuItems,
  onClose,
}: ContextMenuNavigationParams) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{ x: number; y: number } | null>(null);
  const [focusedIndex, setFocusedIndex] = useState<number | null>(null);

  // Initial position (below-right of cursor); used for first paint so we can measure
  const cursorOffset = 4;
  const initialPosition = { x: position.x + cursorOffset, y: position.y + cursorOffset };

  // Measure real menu size and clamp to viewport (runs after first paint)
  useLayoutEffect(() => {
    if (isMobile || !isOpen || !menuRef.current) return;

    const el = menuRef.current;
    const rect = el.getBoundingClientRect();
    const padding = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = position.x + cursorOffset;
    let top = position.y + cursorOffset;

    // Horizontal: keep fully in viewport
    if (left + rect.width > vw - padding) left = vw - rect.width - padding;
    if (left < padding) left = padding;

    // Vertical: if menu would extend past bottom, open above cursor; then clamp to viewport
    if (top + rect.height > vh - padding) {
      top = position.y - rect.height - cursorOffset;
    }
    if (top < padding) top = padding;
    if (top + rect.height > vh - padding) {
      top = vh - rect.height - padding;
    }

    setPlacement({ x: left, y: top });
  }, [isOpen, isMobile, position.x, position.y]);

  // Visible only after the measure above; re-measures on reopen before paint.
  const menuStyle = placement ?? initialPosition;
  const menuVisible = isOpen && placement !== null;

  useEffect(() => {
    if (!isOpen || isMobile) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleEscKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isOpen) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setFocusedIndex(prev => (prev === null ? 0 : Math.min(prev + 1, menuItems.length - 1)));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setFocusedIndex(prev => (prev === null ? menuItems.length - 1 : Math.max(prev - 1, 0)));
      } else if (event.key === 'Enter' && focusedIndex !== null) {
        event.preventDefault();
        const item = menuItems[focusedIndex];
        if (item && !item.disabled) {
          item.action();
          onClose();
        }
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscKey);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscKey);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose, menuItems, focusedIndex, isMobile]);

  return { menuRef, menuStyle, menuVisible, focusedIndex, setFocusedIndex };
}
