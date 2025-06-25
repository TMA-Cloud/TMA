import React from "react";

interface StorageChartProps {
  used: number;
  total: number;
}

export const StorageChart: React.FC<StorageChartProps> = ({ used, total }) => {
  const percentage = (used / total) * 100;
  const remaining = total - used;

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return "0 Bytes";
    const k = 1024;
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl p-6 border border-gray-200 dark:border-gray-700">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
        Storage Usage
      </h3>

      <div className="relative w-32 h-32 mx-auto mb-4">
        <svg className="w-32 h-32 transform -rotate-90" viewBox="0 0 36 36">
          {/* Background circle */}
          <path
            d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-gray-200 dark:text-gray-700"
          />
          {/* Progress circle */}
          <path
            d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeDasharray={`${percentage}, 100`}
            className="text-blue-500"
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <p className="text-xl font-bold text-gray-900 dark:text-gray-100">
              {Math.round(percentage)}%
            </p>
            <p className="text-xs text-gray-500 dark:text-gray-400">Used</p>
          </div>
        </div>
      </div>

      <div className="space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-gray-600 dark:text-gray-400">Used:</span>
          <span className="font-medium text-gray-900 dark:text-gray-100">
            {formatBytes(used)}
          </span>
        </div>
        <div className="flex justify-between">
          <span className="text-gray-600 dark:text-gray-400">Available:</span>
          <span className="font-medium text-gray-900 dark:text-gray-100">
            {formatBytes(remaining)}
          </span>
        </div>
        <div className="flex justify-between border-t border-gray-200 dark:border-gray-700 pt-2">
          <span className="text-gray-600 dark:text-gray-400">Total:</span>
          <span className="font-medium text-gray-900 dark:text-gray-100">
            {formatBytes(total)}
          </span>
        </div>
      </div>
    </div>
  );
};
