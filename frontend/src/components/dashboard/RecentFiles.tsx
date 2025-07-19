import React from "react";
import { FileItem } from "../../contexts/AppContext";
import { getFileIcon, formatFileSize } from "../../utils/fileUtils";
import { Tooltip } from "../ui/Tooltip";

interface RecentFilesProps {
  files: FileItem[];
}

export const RecentFiles: React.FC<RecentFilesProps> = ({ files }) => {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl p-6 border border-gray-200 dark:border-gray-700">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
        Recent Files
      </h3>

      <div className="space-y-3">
        {files.slice(0, 5).map((file) => {
          const Icon = getFileIcon(file);

          return (
            <div
              key={file.id}
              className="flex items-center space-x-3 p-2 rounded-lg hover:bg-blue-50/60 dark:hover:bg-blue-900/30 cursor-pointer group transition-all duration-200"
            >
              <div className="flex-shrink-0">
                <Icon className="w-8 h-8 text-blue-500" />
              </div>
              <div className="flex-1 min-w-0">
                <Tooltip text={file.name}>
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                    {file.name}
                  </p>
                </Tooltip>
                <div className="text-xs text-gray-500 dark:text-gray-400 flex items-center space-x-2 opacity-80 group-hover:opacity-100 transition-opacity duration-200">
                  {file.type === "file" && file.size && (
                    <span>{formatFileSize(file.size)}</span>
                  )}
                  <span>•</span>
                  <span>{file.modified.toLocaleDateString()}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
