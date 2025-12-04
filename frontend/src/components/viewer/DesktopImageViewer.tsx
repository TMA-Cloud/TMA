import React, { useState, useEffect, useRef } from "react";
import { Modal } from "../ui/Modal";
import { ZoomIn, ZoomOut } from "lucide-react";
import { type FileItem } from "../../contexts/AppContext";

interface DesktopImageViewerProps {
  imageViewerFile: FileItem | null;
  onClose: () => void;
}

export const DesktopImageViewer: React.FC<DesktopImageViewerProps> = ({
  imageViewerFile,
  onClose,
}) => {
  const [zoom, setZoom] = useState(1);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const initialFitZoom = useRef<number>(1);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const offset = useRef({ x: 0, y: 0 });
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const lastMousePos = useRef({ x: 0, y: 0 });

  useEffect(() => {
    let revoke: (() => void) | undefined;
    if (imageViewerFile) {
      setLoading(true);
      const load = async () => {
        try {
          const res = await fetch(`/api/files/${imageViewerFile.id}/download`, {
            credentials: "include",
          });
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          setImageSrc(url);

          // Calculate initial fit when image loads
          const img = new Image();
          img.onload = () => {
            const container = containerRef.current;
            if (container) {
              const cw = container.clientWidth;
              const ch = container.clientHeight;
              const iw = img.naturalWidth;
              const ih = img.naturalHeight;

              // Calculate scale to fit image within container
              const scale = Math.min(cw / iw, ch / ih, 1);
              initialFitZoom.current = scale;

              // Set initial zoom to fit
              setZoom(scale);

              // Center the image
              const fittedWidth = iw * scale;
              const fittedHeight = ih * scale;
              offset.current = {
                x: (cw - fittedWidth) / 2,
                y: (ch - fittedHeight) / 2,
              };

              // Apply the initial transform
              requestAnimationFrame(() => {
                if (wrapperRef.current) {
                  wrapperRef.current.style.transform = `translate(${offset.current.x}px, ${offset.current.y}px) scale(${scale})`;
                  wrapperRef.current.style.transformOrigin = "0 0";
                }
              });
            }
          };
          img.src = url;

          revoke = () => URL.revokeObjectURL(url);
        } catch {
          setImageSrc(null);
        } finally {
          setLoading(false);
        }
      };
      load();
    } else {
      setImageSrc(null);
      initialFitZoom.current = 1;
    }
    return () => revoke?.();
  }, [imageViewerFile]);

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

  const applyTransform = (newZoom = zoom) => {
    clampOffset(newZoom);
    if (wrapperRef.current) {
      wrapperRef.current.style.transform = `translate(${offset.current.x}px, ${offset.current.y}px) scale(${newZoom})`;
    }
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    setDragging(true);
    dragOrigin.current = { x: e.clientX, y: e.clientY };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  };

  const handlePointerMove = (e: PointerEvent) => {
    lastMousePos.current = { x: e.clientX, y: e.clientY };
    if (!dragOrigin.current) return;
    const dx = e.clientX - dragOrigin.current.x;
    const dy = e.clientY - dragOrigin.current.y;
    dragOrigin.current = { x: e.clientX, y: e.clientY };
    offset.current.x += dx;
    offset.current.y += dy;
    applyTransform();
  };

  const handlePointerUp = () => {
    setDragging(false);
    dragOrigin.current = null;
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const newZoom =
      e.deltaY < 0 ? Math.min(zoom + 0.25, 5) : Math.max(zoom - 0.25, 0.25);
    const wrap = wrapperRef.current;
    if (!wrap) {
      setZoom(newZoom);
      return;
    }

    const rect = wrap.getBoundingClientRect();
    const imgX = (e.clientX - rect.left - offset.current.x) / zoom;
    const imgY = (e.clientY - rect.top - offset.current.y) / zoom;

    offset.current = {
      x: e.clientX - rect.left - imgX * newZoom,
      y: e.clientY - rect.top - imgY * newZoom,
    };

    setZoom(newZoom);
    applyTransform(newZoom);
  };

  const zoomAtCursor = (newZoom: number) => {
    const wrap = wrapperRef.current;
    if (!wrap) return setZoom(newZoom);

    const rect = wrap.getBoundingClientRect();
    const { x: cx, y: cy } = lastMousePos.current;
    const imgX = (cx - rect.left - offset.current.x) / zoom;
    const imgY = (cy - rect.top - offset.current.y) / zoom;

    offset.current = {
      x: cx - rect.left - imgX * newZoom,
      y: cy - rect.top - imgY * newZoom,
    };
    setZoom(newZoom);
    applyTransform(newZoom);
  };

  const zoomInHandler = () => zoomAtCursor(Math.min(zoom + 0.25, 5));
  const zoomOutHandler = () => zoomAtCursor(Math.max(zoom - 0.25, 0.25));

  const resetZoom = () => {
    // Reset to initial fit zoom
    const fitZoom = initialFitZoom.current;
    setZoom(fitZoom);
    // Offset will be centered by clampOffset
    offset.current = { x: 0, y: 0 };
    applyTransform(fitZoom);
  };

  if (!imageViewerFile) return null;

  return (
    <Modal isOpen onClose={onClose} title={imageViewerFile.name} size="xl">
      <div className="relative flex justify-center items-center h-[70vh] bg-gray-100 dark:bg-gray-900 rounded-md overflow-hidden">
        <div
          ref={containerRef}
          onPointerDown={handlePointerDown}
          onWheel={handleWheel}
          onMouseMove={(e) =>
            (lastMousePos.current = { x: e.clientX, y: e.clientY })
          }
          onDoubleClick={resetZoom}
          className={`w-full h-full touch-none ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
        >
          <div
            ref={wrapperRef}
            className="transition-transform will-change-transform"
            style={{
              transform: `translate(${offset.current.x}px, ${offset.current.y}px) scale(${zoom})`,
              transformOrigin: "0 0",
            }}
          >
            {loading ? (
              <div className="flex justify-center items-center h-full">
                <span className="text-sm text-gray-500 dark:text-gray-400">
                  Loading image...
                </span>
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
        <div className="absolute bottom-4 right-4 flex items-center space-x-2 bg-white/80 dark:bg-gray-800/80 px-3 py-2 rounded-md shadow-md">
          <button
            onClick={zoomOutHandler}
            className="p-1.5 rounded hover:bg-gray-200 dark:hover:bg-gray-700"
            disabled={zoom <= 0.25}
            title="Zoom Out"
          >
            <ZoomOut className="w-5 h-5" />
          </button>
          <span className="text-sm w-12 text-center">
            {(zoom * 100).toFixed(0)}%
          </span>
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
