import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Modal } from '../ui/Modal';
import { ZoomIn, ZoomOut } from 'lucide-react';
import { type FileItem } from '../../contexts/AppContext';
import { useImageBlob } from '../../hooks/useImageBlob';

interface DesktopImageViewerProps {
  imageViewerFile: FileItem | null;
  onClose: () => void;
}

export const DesktopImageViewer: React.FC<DesktopImageViewerProps> = ({ imageViewerFile, onClose }) => {
  const [zoom, setZoom] = useState(1);
  const { imageSrc, loading } = useImageBlob(imageViewerFile?.id);
  const [initialFitZoom, setInitialFitZoom] = useState(1);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const offset = useRef({ x: 0, y: 0 });
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const lastMousePos = useRef({ x: 0, y: 0 });
  const rafId = useRef<number | null>(null);

  useEffect(() => {
    if (!imageSrc) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setInitialFitZoom(1);
      return;
    }
    const img = new Image();
    img.onload = () => {
      const container = containerRef.current;
      if (container) {
        const cw = container.clientWidth;
        const ch = container.clientHeight;
        const iw = img.naturalWidth;
        const ih = img.naturalHeight;

        const scale = Math.min(cw / iw, ch / ih, 1);
        setInitialFitZoom(scale);
        setZoom(scale);

        const fittedWidth = iw * scale;
        const fittedHeight = ih * scale;
        offset.current = {
          x: (cw - fittedWidth) / 2,
          y: (ch - fittedHeight) / 2,
        };

        requestAnimationFrame(() => {
          if (wrapperRef.current) {
            wrapperRef.current.style.transform = `translate3d(${offset.current.x}px, ${offset.current.y}px, 0) scale(${scale})`;
            wrapperRef.current.style.transformOrigin = '0 0';
          }
        });
      }
    };
    img.src = imageSrc;
  }, [imageSrc]);

  const clampOffset = (newZoom: number) => {
    const cont = containerRef.current;
    const img = imgRef.current;
    if (!cont || !img) return;

    const cw = cont.clientWidth;
    const ch = cont.clientHeight;
    const iw = img.naturalWidth * newZoom;
    const ih = img.naturalHeight * newZoom;

    // If image is smaller than container, center it
    if (iw <= cw) {
      offset.current.x = (cw - iw) / 2;
    } else {
      // If image is larger, clamp to boundaries
      const minX = cw - iw;
      const maxX = 0;
      offset.current.x = Math.max(minX, Math.min(maxX, offset.current.x));
    }

    if (ih <= ch) {
      offset.current.y = (ch - ih) / 2;
    } else {
      const minY = ch - ih;
      const maxY = 0;
      offset.current.y = Math.max(minY, Math.min(maxY, offset.current.y));
    }
  };

  const applyTransform = (newZoom = zoom, skipClamp = false) => {
    if (!skipClamp) {
      clampOffset(newZoom);
    }
    if (wrapperRef.current) {
      // Use translate3d for GPU acceleration
      wrapperRef.current.style.transform = `translate3d(${offset.current.x}px, ${offset.current.y}px, 0) scale(${newZoom})`;
    }
  };

  const pointerMoveRef = useRef<((e: PointerEvent) => void) | null>(null);
  const pointerUpRef = useRef<(() => void) | null>(null);

  const stablePointerMove = useCallback((e: PointerEvent) => pointerMoveRef.current?.(e), []);
  const stablePointerUp = useCallback(() => pointerUpRef.current?.(), []);

  useEffect(() => {
    pointerMoveRef.current = (e: PointerEvent) => {
      lastMousePos.current = { x: e.clientX, y: e.clientY };
      if (!dragOrigin.current) return;

      const dx = e.clientX - dragOrigin.current.x;
      const dy = e.clientY - dragOrigin.current.y;
      dragOrigin.current = { x: e.clientX, y: e.clientY };
      offset.current.x += dx;
      offset.current.y += dy;

      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
      }

      rafId.current = requestAnimationFrame(() => {
        applyTransform(zoom, true);
        rafId.current = null;
      });
    };

    pointerUpRef.current = () => {
      setDragging(false);
      dragOrigin.current = null;

      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
        rafId.current = null;
      }

      requestAnimationFrame(() => {
        applyTransform(zoom, false);
      });

      window.removeEventListener('pointermove', stablePointerMove);
      window.removeEventListener('pointerup', stablePointerUp);
    };
  });

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    setDragging(true);
    dragOrigin.current = { x: e.clientX, y: e.clientY };
    window.addEventListener('pointermove', stablePointerMove);
    window.addEventListener('pointerup', stablePointerUp);
  };

  const handleWheel = useCallback(
    (e: WheelEvent) => {
      e.preventDefault();
      setZoom(currentZoom => {
        const minZoom = Math.max(0.1, initialFitZoom || 0.25);
        const newZoom = e.deltaY < 0 ? Math.min(currentZoom + 0.25, 5) : Math.max(currentZoom - 0.25, minZoom);

        // Use the (untransformed) container as the reference frame. The wrapper
        // itself is translated, so its rect already includes offset — using it
        // here would double-count the offset and zoom toward the wrong point.
        const cont = containerRef.current;
        if (!cont) return newZoom;
        const rect = cont.getBoundingClientRect();
        const relX = e.clientX - rect.left;
        const relY = e.clientY - rect.top;
        const imgX = (relX - offset.current.x) / currentZoom;
        const imgY = (relY - offset.current.y) / currentZoom;

        offset.current = {
          x: relX - imgX * newZoom,
          y: relY - imgY * newZoom,
        };

        // Apply transform inline to avoid dependency on applyTransform
        clampOffset(newZoom);
        if (wrapperRef.current) {
          wrapperRef.current.style.transform = `translate3d(${offset.current.x}px, ${offset.current.y}px, 0) scale(${newZoom})`;
        }

        return newZoom;
      });
    },
    [initialFitZoom]
  );

  const zoomAtCursor = (newZoom: number) => {
    const cont = containerRef.current;
    if (!cont) return setZoom(newZoom);

    // Reference the untransformed container, not the translated wrapper, so the
    // focal point math doesn't double-count the offset.
    const rect = cont.getBoundingClientRect();
    const { x: cx, y: cy } = lastMousePos.current;
    const relX = cx - rect.left;
    const relY = cy - rect.top;
    const imgX = (relX - offset.current.x) / zoom;
    const imgY = (relY - offset.current.y) / zoom;

    offset.current = {
      x: relX - imgX * newZoom,
      y: relY - imgY * newZoom,
    };
    setZoom(newZoom);
    applyTransform(newZoom);
  };

  const zoomInHandler = () => zoomAtCursor(Math.min(zoom + 0.25, 5));
  const zoomOutHandler = () => {
    const minZoom = Math.max(0.1, initialFitZoom || 0.25);
    zoomAtCursor(Math.max(zoom - 0.25, minZoom));
  };

  const resetZoom = () => {
    setZoom(initialFitZoom);
    offset.current = { x: 0, y: 0 };
    applyTransform(initialFitZoom);
  };

  // Attach wheel event listener with passive: false to allow preventDefault
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', handleWheel);
      window.removeEventListener('pointermove', stablePointerMove);
      window.removeEventListener('pointerup', stablePointerUp);
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
        rafId.current = null;
      }
    };
  }, [handleWheel, stablePointerMove, stablePointerUp]);

  if (!imageViewerFile) return null;

  return (
    <Modal isOpen onClose={onClose} title={imageViewerFile.name} size="xl">
      <div className="relative flex justify-center items-center h-[70vh] bg-gray-100 dark:bg-gray-900 rounded-md overflow-hidden">
        <div
          ref={containerRef}
          onPointerDown={handlePointerDown}
          onMouseMove={e => (lastMousePos.current = { x: e.clientX, y: e.clientY })}
          onDoubleClick={resetZoom}
          className={`w-full h-full touch-none ${dragging ? 'cursor-grabbing' : 'cursor-grab'}`}
          style={{ willChange: dragging ? 'transform' : 'auto' }}
        >
          <div
            ref={wrapperRef}
            className="will-change-transform"
            style={{
              transformOrigin: '0 0',
              backfaceVisibility: 'hidden',
              perspective: 1000,
            }}
          >
            {loading ? (
              <div className="flex justify-center items-center h-full">
                <span className="text-sm text-gray-500 dark:text-gray-400">Loading image...</span>
              </div>
            ) : (
              imageSrc && (
                <img
                  ref={imgRef}
                  src={imageSrc}
                  alt={imageViewerFile.name}
                  draggable={false}
                  className="select-none pointer-events-none max-w-none"
                />
              )
            )}
          </div>
        </div>

        {/* Zoom controls */}
        <div className="absolute bottom-4 right-4 flex items-center space-x-2 bg-[#dfe3ea]/95 dark:bg-gray-800/80 px-3 py-2 rounded-md shadow-md">
          <button
            onClick={zoomOutHandler}
            className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
            disabled={zoom <= Math.max(0.1, initialFitZoom || 0.25)}
            title="Zoom Out"
          >
            <ZoomOut className="w-5 h-5" />
          </button>
          <span className="text-sm w-12 text-center">{(zoom * 100).toFixed(0)}%</span>
          <button
            onClick={zoomInHandler}
            className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
            disabled={zoom >= 5}
            title="Zoom In"
          >
            <ZoomIn className="w-5 h-5" />
          </button>
        </div>
      </div>
    </Modal>
  );
};
