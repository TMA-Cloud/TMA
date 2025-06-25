import React, { useRef, useState, useEffect } from "react";

interface MarqueeSelectorProps {
  onSelectionChange: (selectedIds: string[]) => void;
  children: React.ReactNode;
}

interface SelectionRect {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
}

export const MarqueeSelector: React.FC<MarqueeSelectorProps> = ({
  onSelectionChange,
  children,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionRect, setSelectionRect] = useState<SelectionRect | null>(
    null,
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let startX = 0;
    let startY = 0;

    const handleMouseDown = (e: MouseEvent) => {
      if (e.target !== container) return;

      const rect = container.getBoundingClientRect();
      startX = e.clientX - rect.left;
      startY = e.clientY - rect.top;

      setIsSelecting(true);
      setSelectionRect({
        startX,
        startY,
        endX: startX,
        endY: startY,
      });
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isSelecting) return;

      const rect = container.getBoundingClientRect();
      const endX = e.clientX - rect.left;
      const endY = e.clientY - rect.top;

      setSelectionRect({
        startX,
        startY,
        endX,
        endY,
      });

      // Calculate selected items
      const selectedIds: string[] = [];
      const items = container.querySelectorAll("[data-file-id]");

      items.forEach((item) => {
        const itemRect = item.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();

        const itemLeft = itemRect.left - containerRect.left;
        const itemTop = itemRect.top - containerRect.top;
        const itemRight = itemLeft + itemRect.width;
        const itemBottom = itemTop + itemRect.height;

        const selectionLeft = Math.min(startX, endX);
        const selectionTop = Math.min(startY, endY);
        const selectionRight = Math.max(startX, endX);
        const selectionBottom = Math.max(startY, endY);

        // Check for intersection
        if (
          !(
            itemRight < selectionLeft ||
            itemLeft > selectionRight ||
            itemBottom < selectionTop ||
            itemTop > selectionBottom
          )
        ) {
          const fileId = item.getAttribute("data-file-id");
          if (fileId) selectedIds.push(fileId);
        }
      });

      onSelectionChange(selectedIds);
    };

    const handleMouseUp = () => {
      setIsSelecting(false);
      setSelectionRect(null);
    };

    container.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      container.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isSelecting, onSelectionChange]);

  const getSelectionStyle = () => {
    if (!selectionRect) return {};

    const { startX, startY, endX, endY } = selectionRect;
    const left = Math.min(startX, endX);
    const top = Math.min(startY, endY);
    const width = Math.abs(endX - startX);
    const height = Math.abs(endY - startY);

    return {
      left: `${left}px`,
      top: `${top}px`,
      width: `${width}px`,
      height: `${height}px`,
    };
  };

  return (
    <div ref={containerRef} className="relative select-none">
      {children}
      {isSelecting && selectionRect && (
        <div
          className="absolute border-2 border-blue-500 bg-blue-500 bg-opacity-20 pointer-events-none z-10"
          style={getSelectionStyle()}
        />
      )}
    </div>
  );
};
