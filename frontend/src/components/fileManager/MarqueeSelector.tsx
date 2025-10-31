// MarqueeSelector.tsx
import React, { useRef, useState, useEffect } from "react";

interface MarqueeSelectorProps {
  onSelectionChange: (selectedIds: string[], additive: boolean) => void;
  onSelectingChange?: (selecting: boolean) => void;
  children: React.ReactNode;
}

interface SelectionRect {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  // precomputed CSS box values relative to container viewport
  left: number;
  top: number;
  width: number;
  height: number;
}

export const MarqueeSelector: React.FC<MarqueeSelectorProps> = ({
  onSelectionChange,
  onSelectingChange,
  children,
}) => {
  // keep latest callbacks in refs
  const onSelectionChangeRef = useRef(onSelectionChange);
  const onSelectingChangeRef = useRef(onSelectingChange);
  useEffect(() => {
    onSelectionChangeRef.current = onSelectionChange;
    onSelectingChangeRef.current = onSelectingChange;
  }, [onSelectionChange, onSelectingChange]);

  const containerRef = useRef<HTMLDivElement>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(
    null,
  );
  const isSelectingRef = useRef(false);
  const additiveRef = useRef(false);
  const mouseDownRef = useRef(false);

  const cancelSelection = () => {
    setIsSelecting(false);
    isSelectingRef.current = false;
    setSelectionRect(null);
    mouseDownRef.current = false;
    setTimeout(() => onSelectingChangeRef.current?.(false), 50);
  };

  // rAF batching
  const rafRef = useRef<number | null>(null);
  const pendingRectRef = useRef<SelectionRect | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let startX = 0,
      startY = 0;

    const handleMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      const rect = container.getBoundingClientRect();
      startX = e.clientX - rect.left + container.scrollLeft;
      startY = e.clientY - rect.top + container.scrollTop;
      additiveRef.current = e.ctrlKey || e.metaKey;
      mouseDownRef.current = true;
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!mouseDownRef.current) return;
      const rect = container.getBoundingClientRect();
      const curX = e.clientX - rect.left + container.scrollLeft;
      const curY = e.clientY - rect.top + container.scrollTop;

      if (!isSelectingRef.current) {
        const dx = Math.abs(curX - startX);
        const dy = Math.abs(curY - startY);
        if (dx < 5 && dy < 5) return;
        e.preventDefault();
        e.stopPropagation();
        isSelectingRef.current = true;
        setIsSelecting(true);
        onSelectingChangeRef.current?.(true);
      }

      e.preventDefault();
      const newRect = {
        startX,
        startY,
        endX: curX,
        endY: curY,
        left: Math.min(startX, curX) - container.scrollLeft,
        top: Math.min(startY, curY) - container.scrollTop,
        width: Math.abs(curX - startX),
        height: Math.abs(curY - startY),
      };
      pendingRectRef.current = newRect;

      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(() => {
          const r = pendingRectRef.current!;
          setSelectionRect(r);

          // intersection logic
          const selL = Math.min(r.startX, r.endX);
          const selT = Math.min(r.startY, r.endY);
          const selR = Math.max(r.startX, r.endX);
          const selB = Math.max(r.startY, r.endY);

          const selectedIds: string[] = [];
          container
            .querySelectorAll<HTMLElement>("[data-file-id]")
            .forEach((item) => {
              const ir = item.getBoundingClientRect();
              const left = ir.left - rect.left + container.scrollLeft;
              const top = ir.top - rect.top + container.scrollTop;
              const right = left + ir.width;
              const bottom = top + ir.height;

              if (
                !(right < selL || left > selR || bottom < selT || top > selB)
              ) {
                const id = item.getAttribute("data-file-id");
                if (id) selectedIds.push(id);
              }
            });

          onSelectionChangeRef.current(selectedIds, additiveRef.current);
          rafRef.current = null;
        });
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      if (!mouseDownRef.current) return;
      mouseDownRef.current = false;
      if (!isSelectingRef.current) return;

      e.preventDefault();
      e.stopPropagation();

      // ensure last frame runs
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      // flush pendingRect once more
      const rect = container.getBoundingClientRect();
      const endX = e.clientX - rect.left + container.scrollLeft;
      const endY = e.clientY - rect.top + container.scrollTop;
      const finalRect = {
        startX,
        startY,
        endX,
        endY,
        left: Math.min(startX, endX) - container.scrollLeft,
        top: Math.min(startY, endY) - container.scrollTop,
        width: Math.abs(endX - startX),
        height: Math.abs(endY - startY),
      };
      pendingRectRef.current = finalRect;

      // run same logic synchronously
      setSelectionRect(finalRect);
      const selL = Math.min(startX, endX);
      const selT = Math.min(startY, endY);
      const selR = Math.max(startX, endX);
      const selB = Math.max(startY, endY);
      const selectedIds: string[] = [];
      container
        .querySelectorAll<HTMLElement>("[data-file-id]")
        .forEach((item) => {
          const ir = item.getBoundingClientRect();
          const left = ir.left - rect.left + container.scrollLeft;
          const top = ir.top - rect.top + container.scrollTop;
          const right = left + ir.width;
          const bottom = top + ir.height;
          if (!(right < selL || left > selR || bottom < selT || top > selB)) {
            const id = item.getAttribute("data-file-id");
            if (id) selectedIds.push(id);
          }
        });
      onSelectionChangeRef.current(selectedIds, additiveRef.current);

      cancelSelection();
    };

    const handleDragEnd = () => {
      if (!mouseDownRef.current && !isSelectingRef.current) return;
      cancelSelection();
    };

    container.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    document.addEventListener("dragend", handleDragEnd);
    return () => {
      container.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("dragend", handleDragEnd);
    };
  }, []);
  // No setState in effects for style; style values are precomputed into selectionRect

  return (
    <div ref={containerRef} className="relative select-none overflow-visible">
      {children}
      {isSelecting && selectionRect && (
        <div
          className="absolute border-2 border-blue-500 bg-blue-500 bg-opacity-20 pointer-events-none z-10"
          style={{
            left: `${selectionRect.left}px`,
            top: `${selectionRect.top}px`,
            width: `${selectionRect.width}px`,
            height: `${selectionRect.height}px`,
            willChange: "left, top, width, height",
          }}
        />
      )}
    </div>
  );
};
