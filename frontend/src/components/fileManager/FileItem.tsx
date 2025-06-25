import React from "react";
import { FileItem as FileItemType } from "../../contexts/AppContext";
import { getFileIcon, formatFileSize, formatDate } from "../../utils/fileUtils";
import { Star, Share2 } from "lucide-react";

interface FileItemProps {
  file: FileItemType;
  isSelected: boolean;
  viewMode: "grid" | "list";
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

export const FileItemComponent: React.FC<FileItemProps> = ({
  file,
  isSelected,
  viewMode,
  onClick,
  onDoubleClick,
  onContextMenu,
}) => {
  const Icon = getFileIcon(file);

  if (viewMode === "grid") {
    return (
      <div
        data-file-id={file.id}
        className={`
          group relative p-4 rounded-lg border-2 cursor-pointer transition-all duration-200
          hover:shadow-md hover:scale-105
          ${
            isSelected
              ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
              : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 hover:border-gray-300 dark:hover:border-gray-600"
          }
        `}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      >
        <div className="flex flex-col items-center text-center">
          <div className="relative mb-2">
            <Icon
              className={`w-12 h-12 ${file.type === "folder" ? "text-blue-500" : "text-gray-600 dark:text-gray-400"}`}
            />
            {file.starred && (
              <Star className="absolute -top-1 -right-1 w-4 h-4 text-yellow-500 fill-current" />
            )}
            {file.shared && (
              <Share2 className="absolute -top-1 -left-1 w-4 h-4 text-green-500" />
            )}
          </div>

          <p
            className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate w-full"
            title={file.name}
          >
            {file.name}
          </p>

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
        group flex items-center space-x-3 p-3 rounded-lg cursor-pointer transition-colors duration-200
        ${
          isSelected
            ? "bg-blue-50 dark:bg-blue-900/20"
            : "hover:bg-gray-50 dark:hover:bg-gray-700"
        }
      `}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <div className="relative flex-shrink-0">
        <Icon
          className={`w-8 h-8 ${file.type === "folder" ? "text-blue-500" : "text-gray-600 dark:text-gray-400"}`}
        />
        {file.starred && (
          <Star className="absolute -top-1 -right-1 w-3 h-3 text-yellow-500 fill-current" />
        )}
        {file.shared && (
          <Share2 className="absolute -top-1 -left-1 w-3 h-3 text-green-500" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
          {file.name}
        </p>
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
