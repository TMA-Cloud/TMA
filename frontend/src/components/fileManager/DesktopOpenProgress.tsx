import React from 'react';
import { Monitor } from 'lucide-react';

interface DesktopOpenProgressItem {
  fileId: string;
  fileName: string;
  percent: number;
}

interface DesktopOpenProgressProps {
  items: DesktopOpenProgressItem[];
}

export const DesktopOpenProgress: React.FC<DesktopOpenProgressProps> = ({ items }) => {
  if (!items || items.length === 0) return null;

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex flex-col space-y-2">
      {items.map(item => {
        const safePercent = Math.max(0, Math.min(100, Number.isFinite(item.percent) ? item.percent : 0));

        return (
          <div
            key={item.fileId}
            className="w-80 bg-[#dfe3ea] dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-4"
          >
            <div className="flex items-center space-x-2 mb-2">
              <Monitor className="w-4 h-4 text-gray-500 dark:text-gray-400" />
              <div className="flex-1">
                <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Opening file… {safePercent}%</p>
                <p className="text-xs text-gray-600 dark:text-gray-400 truncate">{item.fileName}</p>
              </div>
            </div>
            <div className="bg-gray-200 dark:bg-gray-600 rounded-full h-2">
              <div
                className="bg-blue-500 h-2 rounded-full transition-all duration-200"
                style={{ width: `${safePercent}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
};
