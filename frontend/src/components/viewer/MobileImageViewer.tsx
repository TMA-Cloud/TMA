import React, { useState, useEffect, useRef } from "react";
import { ZoomIn, ZoomOut, X, ChevronLeft, ChevronRight } from "lucide-react";
import { type FileItem } from "../../contexts/AppContext";

interface MobileImageViewerProps {
  imageViewerFile: FileItem | null;
  onClose: () => void;
  files: FileItem[];
  setImageViewerFile: (file: FileItem | null) => void;
}

export const MobileImageViewer: React.FC<MobileImageViewerProps> = ({
  imageViewerFile,
  onClose,
  files,
  setImageViewerFile,
}) => {
  const [zoom, setZoom] = useState(1);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [imageFit, setImageFit] = useState<{
    width: number;
    height: number;
  } | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const offset = useRef({ x: 0, y: 0 });
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);
  const lastMousePos = useRef({ x: 0, y: 0 });

  // Touch/pinch zoom state
  const touchDistance = useRef<number | null>(null);
  const touchCenter = useRef<{ x: number; y: number } | null>(null);
  const initialZoom = useRef(1);

  // Swipe navigation state
  const swipeStart = useRef<{ x: number; y: number; time: number } | null>(
    null,
  );
  const swipeThreshold = 50; // pixels
  const swipeTimeThreshold = 300; // ms

  // Get all image files for navigation
  const imageFiles = files.filter(
    (f) => f.type === "file" && f.mimeType?.startsWith("image/"),
  );
  const currentIndex = imageViewerFile
    ? imageFiles.findIndex((f) => f.id === imageViewerFile.id)
    : -1;
  const hasNext = currentIndex >= 0 && currentIndex < imageFiles.length - 1;
  const hasPrev = currentIndex > 0;

  useEffect(() => {
    let revoke: (() => void) | undefined;
    if (imageViewerFile) {
      setZoom(1);
      offset.current = { x: 0, y: 0 };
      setLoading(true);
      setControlsVisible(true);
      const load = async () => {
        try {
          const res = await fetch(`/api/files/${imageViewerFile.id}/download`, {
            credentials: "include",
          });
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          setImageSrc(url);

          // Calculate initial fit
          const img = new Image();
          img.onload = () => {
            const container = containerRef.current;
            if (container) {
              const cw = container.clientWidth;
              const ch = container.clientHeight;
              const iw = img.naturalWidth;
              const ih = img.naturalHeight;

              const scale = Math.min(cw / iw, ch / ih, 1); // Fit to screen, max 1x
              const fittedWidth = iw * scale;
              const fittedHeight = ih * scale;
              setImageFit({ width: fittedWidth, height: fittedHeight });

              // Center the image initially
              offset.current = {
                x: (cw - fittedWidth) / 2,
                y: (ch - fittedHeight) / 2,
              };
              // Apply the initial transform
              requestAnimationFrame(() => {
                if (wrapperRef.current) {
                  wrapperRef.current.style.transform = `translate(${offset.current.x}px, ${offset.current.y}px) scale(1)`;
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
      setImageFit(null);
    }
    return () => revoke?.();
  }, [imageViewerFile]);

  // Auto-hide controls on mobile after 3 seconds
  useEffect(() => {
    if (imageViewerFile && !loading && controlsVisible) {
      const timer = setTimeout(() => {
        if (zoom === 1) {
          setControlsVisible(false);
        }
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [imageViewerFile, loading, controlsVisible, zoom]);

  const navigateToImage = (direction: "next" | "prev") => {
    if (direction === "next" && hasNext) {
      setImageViewerFile(imageFiles[currentIndex + 1]);
    } else if (direction === "prev" && hasPrev) {
      setImageViewerFile(imageFiles[currentIndex - 1]);
    }
  };

  const clampOffset = (newZoom: number) => {
    const cont = containerRef.current;
    const img = imgRef.current;
    if (!cont || !img || !imageFit) return;

    const cw = cont.clientWidth;
    const ch = cont.clientHeight;
    const iw = imageFit.width * newZoom;
    const ih = imageFit.height * newZoom;

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

  const applyTransform = (newZoom = zoom, smooth = false) => {
    clampOffset(newZoom);
    if (wrapperRef.current) {
      wrapperRef.current.style.transition = smooth
        ? "transform 0.2s ease-out"
        : "none";
      wrapperRef.current.style.transform = `translate(${offset.current.x}px, ${offset.current.y}px) scale(${newZoom})`;
      wrapperRef.current.style.transformOrigin = "0 0";
    }
  };

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "touch") return; // Let touch handlers take over
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
    dragOrigin.current = null;
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
  };

  // Touch handlers for pinch-to-zoom and swipe
  const getTouchDistance = (touches: TouchList) => {
    if (touches.length < 2) return null;
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const getTouchCenter = (touches: TouchList) => {
    if (touches.length < 2) return null;
    return {
      x: (touches[0].clientX + touches[1].clientX) / 2,
      y: (touches[0].clientY + touches[1].clientY) / 2,
    };
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      e.preventDefault();
      touchDistance.current = getTouchDistance(e.touches);
      touchCenter.current = getTouchCenter(e.touches);
      initialZoom.current = zoom;
      if (touchCenter.current && wrapperRef.current) {
        const rect = wrapperRef.current.getBoundingClientRect();
        lastMousePos.current = {
          x: touchCenter.current.x - rect.left,
          y: touchCenter.current.y - rect.top,
        };
      }
    } else if (e.touches.length === 1 && zoom === 1) {
      // Single touch - prepare for swipe or pan
      const touch = e.touches[0];
      swipeStart.current = {
        x: touch.clientX,
        y: touch.clientY,
        time: Date.now(),
      };
      dragOrigin.current = { x: touch.clientX, y: touch.clientY };
    } else if (e.touches.length === 1 && zoom > 1) {
      // Pan when zoomed
      const touch = e.touches[0];
      dragOrigin.current = { x: touch.clientX, y: touch.clientY };
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (
      e.touches.length === 2 &&
      touchDistance.current &&
      touchCenter.current
    ) {
      e.preventDefault();
      const newDistance = getTouchDistance(e.touches);
      if (!newDistance || !containerRef.current || !imageFit) return;

      const scale = newDistance / touchDistance.current;
      const newZoom = Math.max(0.5, Math.min(5, initialZoom.current * scale));

      const newCenter = getTouchCenter(e.touches);
      if (!newCenter) return;

      const contRect = containerRef.current.getBoundingClientRect();
      const relX = newCenter.x - contRect.left;
      const relY = newCenter.y - contRect.top;

      // Point on image in original (fitted) coordinates
      const imgX = (relX - offset.current.x) / zoom;
      const imgY = (relY - offset.current.y) / zoom;

      // Calculate new offset to keep the same point under pinch center
      offset.current = {
        x: relX - imgX * newZoom,
        y: relY - imgY * newZoom,
      };

      setZoom(newZoom);
      applyTransform(newZoom);
    } else if (e.touches.length === 1 && dragOrigin.current) {
      // Single touch pan or swipe
      const touch = e.touches[0];
      const dx = touch.clientX - dragOrigin.current.x;
      const dy = touch.clientY - dragOrigin.current.y;

      // Only pan if zoomed in
      if (zoom > 1) {
        e.preventDefault();
        dragOrigin.current = { x: touch.clientX, y: touch.clientY };
        offset.current.x += dx;
        offset.current.y += dy;
        applyTransform();
      }
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    touchDistance.current = null;
    touchCenter.current = null;

    // Handle swipe gestures (only when zoomed out)
    if (swipeStart.current && zoom === 1 && e.changedTouches.length === 1) {
      const touch = e.changedTouches[0];
      const dx = touch.clientX - swipeStart.current.x;
      const dy = touch.clientY - swipeStart.current.y;
      const dt = Date.now() - swipeStart.current.time;

      // Swipe down to dismiss
      if (
        Math.abs(dy) > swipeThreshold &&
        dy > 0 &&
        dt < swipeTimeThreshold &&
        Math.abs(dx) < Math.abs(dy) * 0.5
      ) {
        onClose();
        swipeStart.current = null;
        dragOrigin.current = null;
        return;
      }

      // Swipe left/right to navigate
      if (
        Math.abs(dx) > swipeThreshold &&
        dt < swipeTimeThreshold &&
        Math.abs(dy) < Math.abs(dx) * 0.5
      ) {
        if (dx > 0 && hasPrev) {
          navigateToImage("prev");
        } else if (dx < 0 && hasNext) {
          navigateToImage("next");
        }
      }
    }

    swipeStart.current = null;
    dragOrigin.current = null;
  };

  const zoomAtCursor = (newZoom: number) => {
    const cont = containerRef.current;
    if (!cont || !imageFit) return setZoom(newZoom);

    const { x: cx, y: cy } = lastMousePos.current;
    const contRect = cont.getBoundingClientRect();

    // Calculate point relative to container
    const relX = cx - contRect.left;
    const relY = cy - contRect.top;

    // Point on image in original (fitted) coordinates
    const imgX = (relX - offset.current.x) / zoom;
    const imgY = (relY - offset.current.y) / zoom;

    // Calculate new offset to keep the same point under cursor
    offset.current = {
      x: relX - imgX * newZoom,
      y: relY - imgY * newZoom,
    };

    setZoom(newZoom);
    applyTransform(newZoom, true);
  };

  const zoomInHandler = () => zoomAtCursor(Math.min(zoom + 0.5, 5));
  const zoomOutHandler = () => zoomAtCursor(Math.max(zoom - 0.5, 0.5));

  const resetZoom = () => {
    setZoom(1);
    // Reset offset - will be centered by clampOffset
    offset.current = { x: 0, y: 0 };
    applyTransform(1, true);
  };

  const handleDoubleTap = () => {
    if (zoom === 1) {
      zoomAtCursor(2);
    } else {
      resetZoom();
    }
  };

  const toggleControls = () => {
    setControlsVisible((prev) => !prev);
  };

  if (!imageViewerFile) return null;

  return (
    <div className="fixed inset-0 z-[10000] bg-black">
      {/* Image viewer container - full screen */}
      <div
        ref={containerRef}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onPointerDown={handlePointerDown}
        onWheel={handleWheel}
        onMouseMove={(e) =>
          (lastMousePos.current = { x: e.clientX, y: e.clientY })
        }
        onDoubleClick={handleDoubleTap}
        onClick={toggleControls}
        className="absolute inset-0 w-full h-full touch-none"
      >
        {/* Top bar with close button and title - overlays the image */}
        <div
          className={`absolute top-0 left-0 right-0 z-20 bg-gradient-to-b from-black/80 to-transparent px-4 py-2 flex items-center justify-between transition-opacity duration-300 ${
            controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none"
          }`}
          style={{
            paddingTop: `max(env(safe-area-inset-top, 0px), 8px)`,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <h3 className="text-white text-sm font-medium truncate flex-1 mr-2">
            {imageViewerFile.name}
          </h3>
          <button
            onClick={onClose}
            className="flex-shrink-0 w-10 h-10 flex items-center justify-center rounded-full bg-black/50 text-white hover:bg-black/70 active:scale-95 transition"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div
          ref={wrapperRef}
          className="will-change-transform"
          style={{
            transform: `translate(${offset.current.x}px, ${offset.current.y}px) scale(${zoom})`,
            transformOrigin: "0 0",
          }}
        >
          {loading ? (
            <div className="flex justify-center items-center h-full">
              <div className="text-center">
                <div className="w-12 h-12 mx-auto mb-4 border-4 border-white/30 border-t-white rounded-full animate-spin"></div>
                <span className="text-white/80 text-sm">Loading image...</span>
              </div>
            </div>
          ) : (
            imageSrc && (
              <div className="flex items-center justify-center h-full w-full">
                <img
                  ref={imgRef}
                  src={imageSrc}
                  alt={imageViewerFile.name}
                  draggable={false}
                  className="select-none pointer-events-none max-w-full max-h-full object-contain"
                  style={{
                    width: imageFit ? `${imageFit.width}px` : "auto",
                    height: imageFit ? `${imageFit.height}px` : "auto",
                  }}
                />
              </div>
            )
          )}
        </div>
      </div>

      {/* Navigation arrows (only show when zoomed out and multiple images) */}
      {zoom === 1 && imageFiles.length > 1 && (
        <>
          {hasPrev && (
            <button
              onClick={() => navigateToImage("prev")}
              className={`absolute left-4 top-1/2 -translate-y-1/2 z-20 w-12 h-12 flex items-center justify-center rounded-full bg-black/50 backdrop-blur-md text-white active:scale-95 transition ${
                controlsVisible
                  ? "opacity-100"
                  : "opacity-0 pointer-events-none"
              }`}
              aria-label="Previous image"
            >
              <ChevronLeft className="w-6 h-6" />
            </button>
          )}
          {hasNext && (
            <button
              onClick={() => navigateToImage("next")}
              className={`absolute right-4 top-1/2 -translate-y-1/2 z-20 w-12 h-12 flex items-center justify-center rounded-full bg-black/50 backdrop-blur-md text-white active:scale-95 transition ${
                controlsVisible
                  ? "opacity-100"
                  : "opacity-0 pointer-events-none"
              }`}
              aria-label="Next image"
            >
              <ChevronRight className="w-6 h-6" />
            </button>
          )}
        </>
      )}

      {/* Bottom controls bar */}
      <div
        className={`absolute bottom-0 left-0 right-0 z-20 bg-gradient-to-t from-black/80 to-transparent px-4 py-4 transition-opacity duration-300 ${
          controlsVisible ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
      >
        <div className="flex items-center justify-center space-x-4">
          <button
            onClick={zoomOutHandler}
            className="w-12 h-12 flex items-center justify-center rounded-full bg-white/20 backdrop-blur-md text-white active:scale-95 transition"
            disabled={zoom <= 0.5}
            aria-label="Zoom Out"
          >
            <ZoomOut className="w-6 h-6" />
          </button>
          <button
            onClick={resetZoom}
            className="px-4 py-2 rounded-full bg-white/20 backdrop-blur-md text-white text-sm font-medium active:scale-95 transition"
          >
            {(zoom * 100).toFixed(0)}%
          </button>
          <button
            onClick={zoomInHandler}
            className="w-12 h-12 flex items-center justify-center rounded-full bg-white/20 backdrop-blur-md text-white active:scale-95 transition"
            disabled={zoom >= 5}
            aria-label="Zoom In"
          >
            <ZoomIn className="w-6 h-6" />
          </button>
        </div>

        {/* Image counter */}
        {imageFiles.length > 1 && (
          <div className="text-center mt-2 text-white/80 text-xs">
            {currentIndex + 1} / {imageFiles.length}
          </div>
        )}
      </div>
    </div>
  );
};
