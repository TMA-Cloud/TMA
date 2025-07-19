import React from "react";
import { FileItem as FileItemType } from "../../contexts/AppContext";
import { getFileIcon, formatFileSize, formatDate } from "../../utils/fileUtils";
import { Star, Share2 } from "lucide-react";
import { Tooltip } from "../ui/Tooltip";
import { Eye } from "lucide-react";

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
  const Icon = getFileIcon(file);

  if (viewMode === "grid") {
    return (
      <div
        data-file-id={file.id}
        className={`
          group relative p-4 rounded-2xl border-2 cursor-pointer transition-all duration-200 transform-gpu
          hover:shadow-xl hover:scale-105 will-change-transform backdrop-blur-md hover:z-20
          ${
            isSelected
              ? "border-blue-500 bg-gradient-to-br from-blue-100/80 to-blue-200/60 dark:from-blue-900/40 dark:to-blue-800/30"
              : "border-gray-200 dark:border-gray-700 bg-white/80 dark:bg-gray-800/80 hover:border-blue-300 dark:hover:border-blue-600 hover:bg-gradient-to-br hover:from-blue-50/60 hover:to-blue-100/40 dark:hover:from-blue-900/20 dark:hover:to-blue-800/10"
          }
          ${isDragOver ? "ring-2 ring-blue-400" : ""}
        `}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        draggable={!dragDisabled}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <div className="flex flex-col items-center text-center">
          <div className="relative mb-2">
            <Icon
              className={`w-14 h-14 drop-shadow-md ${file.type === "folder" ? "text-blue-500" : "text-gray-600 dark:text-gray-400"}`}
            />
            {file.starred && (
              <Star className="absolute -top-2 -right-2 w-5 h-5 text-yellow-400 drop-shadow" />
            )}
            {file.shared && (
              <Share2 className="absolute -top-2 -left-2 w-5 h-5 text-green-400 drop-shadow" />
            )}
            {/* Quick preview icon on hover for files */}
            {file.type === "file" && (
              <button
                className="absolute -bottom-3 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-full p-1 shadow-md transition-all duration-200"
                tabIndex={-1}
                title="Quick preview"
                onClick={(e) => {
                  e.stopPropagation();
                  onDoubleClick();
                }}
              >
                <Eye className="w-4 h-4 text-blue-500" />
              </button>
            )}
          </div>

          <Tooltip text={file.name}>
            <p className="text-base font-semibold text-gray-900 dark:text-gray-100 break-words w-full">
              {file.name}
            </p>
          </Tooltip>

          <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            {file.type === "file" && file.size && (
              <p>{formatFileSize(file.size)}</p>
            )}
            <p>{formatDate(file.modified)}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      data-file-id={file.id}
      className={`
        group flex items-center space-x-3 p-3 rounded-xl cursor-pointer transition-all duration-200 transform-gpu
        ${
          isSelected
            ? "bg-blue-50 dark:bg-blue-900/20 shadow-md"
            : "hover:bg-blue-50/60 dark:hover:bg-blue-900/30 hover:bg-gradient-to-r hover:from-blue-50/60 hover:to-blue-100/40 dark:hover:from-blue-900/20 dark:hover:to-blue-800/10"
        }
        ${isDragOver ? "ring-2 ring-blue-400" : ""}
      `}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      draggable={!dragDisabled}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="relative flex-shrink-0">
        <Icon
          className={`w-10 h-10 drop-shadow-md ${file.type === "folder" ? "text-blue-500" : "text-gray-600 dark:text-gray-400"}`}
        />
        {file.starred && (
          <Star className="absolute -top-2 -right-2 w-4 h-4 text-yellow-400 drop-shadow" />
        )}
        {file.shared && (
          <Share2 className="absolute -top-2 -left-2 w-4 h-4 text-green-400 drop-shadow" />
        )}
        {/* Quick preview icon on hover for files */}
        {file.type === "file" && (
          <button
            className="absolute -bottom-3 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-full p-1 shadow-md transition-all duration-200"
            tabIndex={-1}
            title="Quick preview"
            onClick={(e) => {
              e.stopPropagation();
              onDoubleClick();
            }}
          >
            <Eye className="w-4 h-4 text-blue-500" />
          </button>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <Tooltip text={file.name}>
          <p className="text-base font-semibold text-gray-900 dark:text-gray-100 break-words">
            {file.name}
          </p>
        </Tooltip>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {file.type === "file" &&
            file.size &&
            `${formatFileSize(file.size)} • `}
          {formatDate(file.modified)}
        </p>
      </div>
    </div>
  );
};
