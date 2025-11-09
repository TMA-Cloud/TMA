import React from "react";
import { Download } from "lucide-react";

interface DownloadProgressProps {
  isDownloading: boolean;
  hasFolders: boolean;
}

export const DownloadProgress: React.FC<DownloadProgressProps> = ({
  isDownloading,
  hasFolders,
}) => {
  if (!isDownloading) return null;

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-80 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-4">
      <div className="flex items-center space-x-2 mb-2">
        <Download className="w-4 h-4 text-gray-500 dark:text-gray-400" />
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100 flex-1">
          {hasFolders ? "Zipping and downloading..." : "Downloading..."}
        </p>
      </div>
      <div className="bg-gray-200 dark:bg-gray-600 rounded-full h-2">
        <div
          className="bg-blue-500 h-2 rounded-full animate-pulse"
          style={{ width: "100%" }}
        />
      </div>
    </div>
  );
};
