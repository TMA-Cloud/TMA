// MarqueeSelector.tsx
import React, { useRef, useState, useCallback } from 'react';

interface MarqueeSelectorProps {
  onSelectionChange: (selectedIds: string[], additive: boolean) => void;
  onSelectingChange?: (selecting: boolean) => void;
  selectedFiles?: string[];
  children: React.ReactNode;
}

interface SelectionRect {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  left: number;
  top: number;
  width: number;
  height: number;
}

export const MarqueeSelector: React.FC<MarqueeSelectorProps> = ({
  onSelectionChange,
  onSelectingChange,
  selectedFiles = [],
  children,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(null);

  const dragStateRef = useRef({
    isDragging: false,
    isSelecting: false,
    startX: 0,
    startY: 0,
    additive: false,
  });
  const rafRef = useRef<number | null>(null);

  const getSelectedIds = useCallback((rect: SelectionRect) => {
    const container = containerRef.current;
    if (!container) return [];

    const containerRect = container.getBoundingClientRect();
    const selL = Math.min(rect.startX, rect.endX);
    const selT = Math.min(rect.startY, rect.endY);
    const selR = Math.max(rect.startX, rect.endX);
    const selB = Math.max(rect.startY, rect.endY);

    const selectedIds: string[] = [];
    container.querySelectorAll<HTMLElement>('[data-file-id]').forEach(item => {
      const ir = item.getBoundingClientRect();
      const left = ir.left - containerRect.left + container.scrollLeft;
      const top = ir.top - containerRect.top + container.scrollTop;
      const right = left + ir.width;
      const bottom = top + ir.height;

      if (!(right < selL || left > selR || bottom < selT || top > selB)) {
        const id = item.getAttribute('data-file-id');
        if (id) selectedIds.push(id);
      }
    });

    return selectedIds;
  }, []);

  const cancelSelection = useCallback(() => {
    dragStateRef.current.isDragging = false;
    dragStateRef.current.isSelecting = false;
    setIsSelecting(false);
    setSelectionRect(null);
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setTimeout(() => onSelectingChange?.(false), 50);
  }, [onSelectingChange]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Only left mouse button
      if (e.button !== 0) return;

      // Don't interfere with buttons, links, inputs
      const target = e.target as HTMLElement;
      if (target.closest('button') || target.closest('a') || target.closest('input')) {
        return;
      }

      const container = containerRef.current;
      if (!container) return;

      // Check if clicking on an ALREADY SELECTED file - allow drag in that case
      const fileElement = target.closest('[data-file-id]');
      if (fileElement) {
        const fileId = fileElement.getAttribute('data-file-id');
        if (fileId && selectedFiles.includes(fileId)) {
          // Clicking on already selected file - let native drag handle it
          return;
        }
      }

      // For everything else (empty space OR unselected files), start marquee
      e.preventDefault();

      const rect = container.getBoundingClientRect();
      const startX = e.clientX - rect.left + container.scrollLeft;
      const startY = e.clientY - rect.top + container.scrollTop;

      dragStateRef.current = {
        isDragging: true,
        isSelecting: false,
        startX,
        startY,
        additive: e.ctrlKey || e.metaKey,
      };

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!dragStateRef.current.isDragging) return;

        const containerRect = container.getBoundingClientRect();
        const curX = moveEvent.clientX - containerRect.left + container.scrollLeft;
        const curY = moveEvent.clientY - containerRect.top + container.scrollTop;
        const { startX, startY } = dragStateRef.current;

        // Start selection after small threshold
        if (!dragStateRef.current.isSelecting) {
          const dx = Math.abs(curX - startX);
          const dy = Math.abs(curY - startY);
          if (dx < 5 && dy < 5) return;

          dragStateRef.current.isSelecting = true;
          setIsSelecting(true);
          onSelectingChange?.(true);
        }

        moveEvent.preventDefault();

        const newRect: SelectionRect = {
          startX,
          startY,
          endX: curX,
          endY: curY,
          left: Math.min(startX, curX) - container.scrollLeft,
          top: Math.min(startY, curY) - container.scrollTop,
          width: Math.abs(curX - startX),
          height: Math.abs(curY - startY),
        };

        if (rafRef.current === null) {
          rafRef.current = requestAnimationFrame(() => {
            setSelectionRect(newRect);
            const selectedIds = getSelectedIds(newRect);
            onSelectionChange(selectedIds, dragStateRef.current.additive);
            rafRef.current = null;
          });
        }
      };

      const handleMouseUp = (upEvent: MouseEvent) => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);

        if (!dragStateRef.current.isDragging) return;

        if (dragStateRef.current.isSelecting) {
          upEvent.preventDefault();
          upEvent.stopPropagation();

          if (rafRef.current !== null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
          }

          const containerRect = container.getBoundingClientRect();
          const endX = upEvent.clientX - containerRect.left + container.scrollLeft;
          const endY = upEvent.clientY - containerRect.top + container.scrollTop;
          const { startX, startY } = dragStateRef.current;

          const finalRect: SelectionRect = {
            startX,
            startY,
            endX,
            endY,
            left: Math.min(startX, endX) - container.scrollLeft,
            top: Math.min(startY, endY) - container.scrollTop,
            width: Math.abs(endX - startX),
            height: Math.abs(endY - startY),
          };

          const selectedIds = getSelectedIds(finalRect);
          onSelectionChange(selectedIds, dragStateRef.current.additive);
        }

        cancelSelection();
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [onSelectionChange, onSelectingChange, getSelectedIds, cancelSelection, selectedFiles]
  );

  return (
    <div ref={containerRef} className="relative select-none overflow-visible" onMouseDown={handleMouseDown}>
      {children}
      {isSelecting && selectionRect && (
        <div
          className="marquee-selection pointer-events-none"
          style={{
            left: `${selectionRect.left}px`,
            top: `${selectionRect.top}px`,
            width: `${selectionRect.width}px`,
            height: `${selectionRect.height}px`,
            zIndex: 10,
          }}
        >
          {/* Inner glow layer */}
          <div className="marquee-glow" />
          {/* Marching ants border */}
          <div className="marquee-border" />
          {/* Corner accents */}
          <div className="marquee-corner marquee-corner-tl" />
          <div className="marquee-corner marquee-corner-tr" />
          <div className="marquee-corner marquee-corner-bl" />
          <div className="marquee-corner marquee-corner-br" />
        </div>
      )}
    </div>
  );
};
