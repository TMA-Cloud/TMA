import React from "react";
import { FileItem } from "../../contexts/AppContext";
import { getFileIcon } from "../../utils/fileUtils";

interface RecentFilesProps {
  files: FileItem[];
}

export const RecentFiles: React.FC<RecentFilesProps> = ({ files }) => {
  const formatDate = (date: Date) => {
    return new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(
      Math.ceil((date.getTime() - Date.now()) / (1000 * 60 * 60 * 24)),
      "day",
    );
  };

  const formatFileSize = (bytes?: number) => {
    if (!bytes) return "";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl p-6 border border-gray-200 dark:border-gray-700">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
        Recent Files
      </h3>

      <div className="space-y-3">
        {files.slice(0, 6).map((file) => {
          const Icon = getFileIcon(file);

          return (
            <div
              key={file.id}
              className="flex items-center space-x-3 p-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer"
            >
              <div className="flex-shrink-0">
                <Icon className="w-8 h-8 text-blue-500" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                  {file.name}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {file.type === "file" &&
                    file.size &&
                    formatFileSize(file.size)}{" "}
                  • {formatDate(file.modified)}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
