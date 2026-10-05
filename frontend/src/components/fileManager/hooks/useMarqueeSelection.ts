import React, { useRef, useState, useCallback, useEffect, useLayoutEffect } from 'react';
import type { SelectionBounds } from '../marqueeGeometry';

export interface MarqueeSelectorProps {
  getSelectionIds?: (rect: SelectionBounds) => string[];
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

export function useMarqueeSelection({
  onSelectionChange,
  onSelectingChange,
  selectedFiles = [],
  getSelectionIds,
}: Omit<MarqueeSelectorProps, 'children'>) {
  const geometryRef = useRef(getSelectionIds);
  useLayoutEffect(() => {
    geometryRef.current = getSelectionIds;
  }, [getSelectionIds]);
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
  // Track listeners attached during an active drag so they can be torn down if
  // the component unmounts mid-drag (mouseup would otherwise never fire).
  const activeListenersRef = useRef<{
    move: (e: MouseEvent) => void;
    up: (e: MouseEvent) => void;
    scroll: () => void;
  } | null>(null);

  useEffect(() => {
    return () => {
      if (activeListenersRef.current) {
        document.removeEventListener('mousemove', activeListenersRef.current.move);
        document.removeEventListener('mouseup', activeListenersRef.current.up);
        document.removeEventListener('scroll', activeListenersRef.current.scroll, true);
        activeListenersRef.current = null;
      }
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  const getSelectedIds = useCallback((rect: SelectionRect) => {
    const container = containerRef.current;
    if (!container) return [];

    if (geometryRef.current) {
      return geometryRef.current({
        left: Math.min(rect.startX, rect.endX),
        top: Math.min(rect.startY, rect.endY),
        width: Math.abs(rect.endX - rect.startX),
        height: Math.abs(rect.endY - rect.startY),
      });
    }
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

      let pointerX = e.clientX;
      let pointerY = e.clientY;
      const updateSelection = () => {
        if (!dragStateRef.current.isDragging) return;

        const containerRect = container.getBoundingClientRect();
        const curX = pointerX - containerRect.left + container.scrollLeft;
        const curY = pointerY - containerRect.top + container.scrollTop;
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

        const newRect: SelectionRect = {
          startX,
          startY,
          endX: curX,
          endY: curY,
          left: Math.min(startX, curX),
          top: Math.min(startY, curY),
          width: Math.abs(curX - startX),
          height: Math.abs(curY - startY),
        };

        setSelectionRect(newRect);
        const selectedIds = getSelectedIds(newRect);
        onSelectionChange(selectedIds, dragStateRef.current.additive);
      };

      // Coalesce mouse/scroll events, reading the latest pointer and geometry at paint time.
      const scheduleSelection = () => {
        if (rafRef.current !== null) return;
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          updateSelection();
        });
      };
      const handleMouseMove = (moveEvent: MouseEvent) => {
        pointerX = moveEvent.clientX;
        pointerY = moveEvent.clientY;
        moveEvent.preventDefault();
        scheduleSelection();
      };
      const handleScroll = () => {
        if (dragStateRef.current.isSelecting) scheduleSelection();
      };

      const handleMouseUp = (upEvent: MouseEvent) => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.removeEventListener('scroll', handleScroll, true);
        activeListenersRef.current = null;

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
      document.addEventListener('scroll', handleScroll, true);
      activeListenersRef.current = { move: handleMouseMove, up: handleMouseUp, scroll: handleScroll };
    },
    [onSelectionChange, onSelectingChange, getSelectedIds, cancelSelection, selectedFiles]
  );

  return { containerRef, isSelecting, selectionRect, handleMouseDown };
}
