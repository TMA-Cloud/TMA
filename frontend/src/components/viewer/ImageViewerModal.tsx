import React, { useState, useEffect, useRef } from "react";
import { Modal } from "../ui/Modal";
import { useApp } from "../../contexts/AppContext";
import { ZoomIn, ZoomOut } from "lucide-react";

export const ImageViewerModal: React.FC = () => {
  const { imageViewerFile, setImageViewerFile } = useApp();
  const [zoom, setZoom] = useState(1);
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const lastPos = useRef<{ x: number; y: number } | null>(null);
  const pointerId = useRef<number | null>(null);

  useEffect(() => {
    let revoke: (() => void) | undefined;
    if (imageViewerFile) {
      setZoom(1);
      setOffset({ x: 0, y: 0 });
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
  const zoomInHandler = () => setZoom((z) => Math.min(z + 0.25, 5));
  const zoomOutHandler = () => setZoom((z) => Math.max(z - 0.25, 0.25));

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(true);
    pointerId.current = e.pointerId;
    lastPos.current = { x: e.clientX, y: e.clientY };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", endDrag);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!dragging || !lastPos.current) return;
    const dx = e.clientX - lastPos.current.x;
    const dy = e.clientY - lastPos.current.y;
    lastPos.current = { x: e.clientX, y: e.clientY };
    setOffset((o) => ({ x: o.x + dx, y: o.y + dy }));
  };

  const endDrag = () => {
    setDragging(false);
    lastPos.current = null;
    if (pointerId.current !== null) {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", endDrag);
      pointerId.current = null;
    }
  };

  const onWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.deltaY < 0) {
      setZoom((z) => Math.min(z + 0.25, 5));
    } else if (e.deltaY > 0) {
      setZoom((z) => Math.max(z - 0.25, 0.25));
    }
  };

  if (!imageViewerFile) return null;

  return (
    <Modal
      isOpen={!!imageViewerFile}
      onClose={handleClose}
      title={imageViewerFile.name}
      size="xl"
    >
      <div className="relative flex justify-center items-center max-h-[70vh] overflow-hidden">
        <div
          className={`w-full flex justify-center items-center ${
            zoom > 1 ? (dragging ? "cursor-grabbing" : "cursor-grab") : ""
          }`}
          style={{ touchAction: "none" }}
          onPointerDown={onPointerDown}
          onWheel={onWheel}
        >
          {imageSrc && (
            <img
              src={imageSrc}
              alt={imageViewerFile.name}
              style={{
                transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
              }}
              className="transition-transform select-none pointer-events-none"
              draggable={false}
            />
          )}
        </div>
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
