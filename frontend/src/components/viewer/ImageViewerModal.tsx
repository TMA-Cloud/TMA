import React, { useState, useEffect, useRef } from "react";
import { Modal } from "../ui/Modal";
import { useApp } from "../../contexts/AppContext";
import { ZoomIn, ZoomOut } from "lucide-react";

export const ImageViewerModal: React.FC = () => {
  const { imageViewerFile, setImageViewerFile } = useApp();
  const [zoom, setZoom] = useState(1);
  const [imageSrc, setImageSrc] = useState<string | null>(null);

  // refs for DOM nodes
  const containerRef = useRef<HTMLDivElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // pan offset stored in ref
  const offset = useRef({ x: 0, y: 0 });
  // dragging state
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const lastMousePos = useRef({ x: 0, y: 0 });

  // load image blob & reset state
  useEffect(() => {
    let revoke: (() => void) | undefined;
    if (imageViewerFile) {
      setZoom(1);
      offset.current = { x: 0, y: 0 };
      const load = async () => {
        try {
          const res = await fetch(
            `${import.meta.env.VITE_API_URL}/api/files/${imageViewerFile.id}/download`,
            { credentials: "include" },
          );
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          setImageSrc(url);
          revoke = () => URL.revokeObjectURL(url);
        } catch {
          setImageSrc(null);
        }
      };
      load();
    } else {
      setImageSrc(null);
    }
    return () => {
      if (revoke) revoke();
    };
  }, [imageViewerFile]);

  const handleClose = () => setImageViewerFile(null);

  // clamp offset so the image never leaves the container entirely
  const clampOffset = (newZoom: number) => {
    const cont = containerRef.current;
    const img = imgRef.current;
    if (!cont || !img) return;

    const cw = cont.clientWidth;
    const ch = cont.clientHeight;
    const iw = img.naturalWidth * newZoom;
    const ih = img.naturalHeight * newZoom;

    // minimum allowed x/y so right/bottom edges don't go past
    const minX = Math.min(0, cw - iw);
    const minY = Math.min(0, ch - ih);

    offset.current.x = Math.max(minX, Math.min(0, offset.current.x));
    offset.current.y = Math.max(minY, Math.min(0, offset.current.y));
  };

  // apply the transform to the wrapper div
  const applyTransform = (newZoom?: number) => {
    const z = newZoom !== undefined ? newZoom : zoom;
    clampOffset(z);
    if (wrapperRef.current) {
      wrapperRef.current.style.transform = `translate(${offset.current.x}px, ${offset.current.y}px) scale(${z})`;
    }
  };

  // pointer down → start panning
  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    setDragging(true);
    dragOrigin.current = { x: e.clientX, y: e.clientY };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  };

  // pointer move → update offset & transform
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

  // pointer up → stop panning
  const handlePointerUp = () => {
    setDragging(false);
    dragOrigin.current = null;
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
  };

  // wheel → zoom under cursor
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
    // image-space coords of cursor:
    const imgX = (e.clientX - rect.left - offset.current.x) / zoom;
    const imgY = (e.clientY - rect.top - offset.current.y) / zoom;

    // recompute offset so that point stays under cursor
    offset.current = {
      x: e.clientX - rect.left - imgX * newZoom,
      y: e.clientY - rect.top - imgY * newZoom,
    };

    setZoom(newZoom);
    applyTransform(newZoom);
  };

  // buttons → zoom at lastMousePos
  const zoomAtCursor = (newZoom: number) => {
    const wrap = wrapperRef.current;
    if (!wrap) {
      setZoom(newZoom);
      return;
    }
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

  if (!imageViewerFile) return null;

  return (
    <Modal isOpen onClose={handleClose} title={imageViewerFile.name} size="xl">
      <div className="relative flex justify-center items-center max-h-[70vh]">
        {/* container captures drag & wheel */}
        <div
          ref={containerRef}
          onPointerDown={handlePointerDown}
          onWheel={handleWheel}
          onMouseMove={(e) =>
            (lastMousePos.current = { x: e.clientX, y: e.clientY })
          }
          style={{ touchAction: "none" }}
          className={`overflow-hidden max-h-[70vh] ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
        >
          {/* wrapper is translated & scaled */}
          <div
            ref={wrapperRef}
            style={{
              transform: `translate(${offset.current.x}px, ${offset.current.y}px) scale(${zoom})`,
              transformOrigin: "0 0",
            }}
          >
            {imageSrc && (
              <img
                ref={imgRef}
                src={imageSrc}
                alt={imageViewerFile.name}
                draggable={false}
                className="select-none pointer-events-none"
              />
            )}
          </div>
        </div>

        {/* zoom buttons */}
        <div className="absolute bottom-4 right-4 flex space-x-3 bg-white/70 dark:bg-gray-800/70 p-2 rounded-md">
          <button
            onClick={zoomOutHandler}
            className="p-2 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700"
          >
            <ZoomOut className="w-5 h-5" />
          </button>
          <button
            onClick={zoomInHandler}
            className="p-2 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700"
          >
            <ZoomIn className="w-5 h-5" />
          </button>
        </div>
      </div>
    </Modal>
  );
};
