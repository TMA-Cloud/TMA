import React from 'react';
import { RotateCcw } from 'lucide-react';

interface RestoreProgressProps {
  progress: {
    itemCount: number;
    percent: number;
    label: string;
  } | null;
}

export const RestoreProgress: React.FC<RestoreProgressProps> = ({ progress }) => {
  if (!progress) return null;

  const safePercent = Math.max(0, Math.min(100, Number.isFinite(progress.percent) ? progress.percent : 0));

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-80 bg-[#e9f7ee] dark:bg-gray-800 border border-emerald-200/70 dark:border-gray-700 rounded-lg shadow-lg p-4">
      <div className="flex items-center space-x-2 mb-2">
        <RotateCcw className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{progress.label}</p>
          <p className="text-xs text-gray-600 dark:text-gray-400">
            {progress.itemCount} item{progress.itemCount !== 1 ? 's' : ''} selected
          </p>
        </div>
        <span className="text-xs font-medium text-gray-600 dark:text-gray-300">{safePercent}%</span>
      </div>
      <div className="bg-gray-200 dark:bg-gray-600 rounded-full h-2">
        <div
          className="bg-emerald-500 h-2 rounded-full transition-all duration-200"
          style={{ width: `${safePercent}%` }}
        />
      </div>
    </div>
  );
};
