import React, { useRef } from "react";
import { type FileItem as FileItemType } from "../../contexts/AppContext";
import {
  formatFileSize,
  formatDate,
  formatFileNameForTooltip,
} from "../../utils/fileUtils";
import { Star, Share2, Eye } from "lucide-react";
import { Tooltip } from "../ui/Tooltip";
import { useIsMobile } from "../../hooks/useIsMobile";
import { FileTypeIcon } from "./FileTypeIcon";

interface FileItemProps {
  file: FileItemType;
  isSelected: boolean;
  viewMode: "grid" | "list";
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  isDragOver?: boolean;
  dragDisabled?: boolean;
}

export const FileItemComponent: React.FC<FileItemProps> = ({
  file,
  isSelected,
  viewMode,
  onClick,
  onDoubleClick,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  isDragOver,
  dragDisabled,
}) => {
  const isMobile = useIsMobile();
  const longPressTimeoutRef = useRef<number | null>(null);
  const longPressTriggeredRef = useRef(false);

  const clearLongPress = () => {
    if (longPressTimeoutRef.current !== null) {
      window.clearTimeout(longPressTimeoutRef.current);
      longPressTimeoutRef.current = null;
    }
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (!isMobile || dragDisabled) return;
    clearLongPress();
    longPressTriggeredRef.current = false;

    const touch = e.touches[0];
    if (!touch) return;
    const clientX = touch.clientX;
    const clientY = touch.clientY;

    longPressTimeoutRef.current = window.setTimeout(() => {
      longPressTriggeredRef.current = true;
      // Synthesize a mouse-like event for the existing onContextMenu handler
      const syntheticEvent = {
        ...e,
        clientX,
        clientY,
        preventDefault: () => {},
        stopPropagation: () => {},
      } as unknown as React.MouseEvent;
      onContextMenu(syntheticEvent);
    }, 500); // 500ms press-and-hold
  };

  const handleTouchEnd = () => {
    if (!isMobile) return;
    clearLongPress();
  };

  const handleTouchMove = () => {
    if (!isMobile) return;
    // Cancel long press if the finger moves (user is scrolling/dragging)
    clearLongPress();
  };

  const handleClickWrapped = (e: React.MouseEvent) => {
    if (isMobile && longPressTriggeredRef.current) {
      // Suppress the click that follows a long-press
      e.preventDefault();
      e.stopPropagation();
      longPressTriggeredRef.current = false;
      return;
    }
    onClick(e);
  };

  const handleContextMenuWrapped = (e: React.MouseEvent) => {
    if (isMobile) {
      // Prevent native context menu on mobile; we rely on long-press instead
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    onContextMenu(e);
  };

  if (viewMode === "grid") {
    return (
      <div
        data-file-id={file.id}
        className={`
          stagger-item group relative rounded-xl border cursor-pointer
          transition-all duration-200 ease-out transform-gpu
          hover-lift will-change-transform hover:z-20
          active:scale-[0.98]
          ${isMobile ? "min-w-0 w-full p-2 select-none" : "p-4 min-w-0"}
          overflow-hidden
          ${
            isSelected
              ? "border-blue-500 dark:border-blue-400 bg-blue-50/80 dark:bg-blue-900/30 shadow-lg ring-2 ring-blue-500/30 dark:ring-blue-400/30"
              : "border-gray-200/50 dark:border-slate-700/50 bg-white dark:bg-slate-800/50 hover:border-blue-300/50 dark:hover:border-blue-600/50 hover:bg-gray-50/80 dark:hover:bg-slate-800/80"
          }
          ${isDragOver ? "ring-4 ring-blue-400 ring-offset-2 scale-105" : ""}
        `}
        style={{ maxWidth: "100%" }}
        onClick={handleClickWrapped}
        onDoubleClick={onDoubleClick}
        onContextMenu={handleContextMenuWrapped}
        draggable={!dragDisabled && !isMobile}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchMove={handleTouchMove}
      >
        <div
          className={`flex flex-col items-center text-center w-full min-w-0 ${isMobile ? "gap-1" : ""}`}
        >
          <div
            className={`relative ${isMobile ? "mb-1" : "mb-2"} transition-transform duration-200 group-hover:scale-105 flex-shrink-0`}
          >
            <FileTypeIcon
              file={file}
              className={`${isMobile ? "w-10 h-10" : "w-14 h-14"} transition-all duration-200`}
            />
            {file.starred && (
              <Star
                className={`absolute -top-1 -right-1 ${isMobile ? "w-3 h-3" : "w-5 h-5"} text-yellow-400 fill-yellow-400`}
              />
            )}
            {file.shared && (
              <Share2
                className={`absolute -top-1 -left-1 ${isMobile ? "w-3 h-3" : "w-5 h-5"} text-green-400`}
              />
            )}
            {/* Quick preview icon on hover for files */}
            {file.type === "file" && !isMobile && (
              <button
                className="absolute -bottom-3 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 scale-90 group-hover:scale-100 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-full p-1.5 shadow-lg hover:shadow-xl hover:bg-blue-50 dark:hover:bg-blue-900/30 hover:border-blue-400 transition-all duration-200"
                tabIndex={-1}
                title="Quick preview"
                onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                  e.stopPropagation();
                  onDoubleClick();
                }}
              >
                <Eye className="w-4 h-4 text-blue-500 transition-colors duration-200" />
              </button>
            )}
          </div>

          <div className="w-full min-w-0 px-1">
            <div className="w-full min-w-0">
              <Tooltip
                text={formatFileNameForTooltip(file.name, isMobile ? 20 : 35)}
              >
                <p
                  className={`${isMobile ? "text-xs" : "text-base"} font-semibold text-gray-900 dark:text-gray-100 w-full break-words transition-colors duration-200`}
                  style={{
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    wordBreak: "break-word",
                    overflowWrap: "break-word",
                    hyphens: "auto",
                    width: "100%",
                    maxWidth: "100%",
                    lineHeight: "1.3",
                  }}
                >
                  {file.name}
                </p>
              </Tooltip>
            </div>
          </div>

          <div
            className={`${isMobile ? "text-[10px]" : "text-xs"} text-gray-500/80 dark:text-gray-400/80 w-full min-w-0 px-1`}
          >
            {file.type === "file" && file.size && (
              <p className="truncate">{formatFileSize(file.size)}</p>
            )}
            <p className="truncate">{formatDate(file.modified)}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      data-file-id={file.id}
      className={`
        stagger-item group flex items-center space-x-3 p-3.5 rounded-lg cursor-pointer
        transition-all duration-200 ease-out transform-gpu
        hover-lift active:scale-[0.99]
        ${isMobile ? "select-none" : ""}
        ${
          isSelected
            ? "bg-blue-50/90 dark:bg-blue-900/30 shadow-md border-l-4 border-blue-500 dark:border-blue-400 ring-2 ring-blue-500/20 dark:ring-blue-400/20"
            : "hover:bg-gray-50/80 dark:hover:bg-slate-800/60 border-l-4 border-transparent"
        }
        ${isDragOver ? "ring-4 ring-blue-400 ring-offset-2 scale-[1.02]" : ""}
      `}
      onClick={handleClickWrapped}
      onDoubleClick={onDoubleClick}
      onContextMenu={handleContextMenuWrapped}
      draggable={!dragDisabled && !isMobile}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchMove={handleTouchMove}
    >
      <div className="relative flex-shrink-0 transition-transform duration-200 group-hover:scale-105">
        <FileTypeIcon
          file={file}
          className="w-10 h-10 transition-all duration-200"
        />
        {file.starred && (
          <Star className="absolute -top-2 -right-2 w-4 h-4 text-yellow-400 fill-yellow-400" />
        )}
        {file.shared && (
          <Share2 className="absolute -top-2 -left-2 w-4 h-4 text-green-400" />
        )}
        {/* Quick preview icon on hover for files */}
        {file.type === "file" && (
          <button
            className="absolute -bottom-3 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 scale-90 group-hover:scale-100 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-full p-1 shadow-lg hover:shadow-xl hover:bg-blue-50 dark:hover:bg-blue-900/30 hover:border-blue-400 transition-all duration-200"
            tabIndex={-1}
            title="Quick preview"
            onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
              e.stopPropagation();
              onDoubleClick();
            }}
          >
            <Eye className="w-4 h-4 text-blue-500 transition-colors duration-200" />
          </button>
        )}
      </div>

      <div className="flex-1 min-w-0 transition-transform duration-200 group-hover:translate-x-1">
        <div className={isMobile ? "w-full min-w-0" : "w-full min-w-0"}>
          <Tooltip
            text={formatFileNameForTooltip(file.name, isMobile ? 25 : 40)}
          >
            <p
              className="text-base font-semibold text-gray-900 dark:text-gray-100 transition-colors duration-200 break-words leading-tight"
              style={{
                wordBreak: "break-word",
                overflowWrap: "break-word",
                hyphens: "auto",
                lineHeight: "1.4",
              }}
            >
              {file.name}
            </p>
          </Tooltip>
        </div>
        <p className="text-xs text-gray-500/80 dark:text-gray-400/80 transition-colors duration-200">
          {file.type === "file" &&
            file.size &&
            `${formatFileSize(file.size)} • `}
          {formatDate(file.modified)}
        </p>
      </div>
    </div>
  );
};
