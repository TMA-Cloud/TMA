import React from 'react';
import { ClipboardPaste } from 'lucide-react';

interface PasteProgressProps {
  progress: number | null;
}

export const PasteProgress: React.FC<PasteProgressProps> = ({ progress }) => {
  if (progress === null) return null;

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-80 bg-[#dfe3ea] dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-4">
      <div className="flex items-center space-x-2 mb-2">
        <ClipboardPaste className="w-4 h-4 text-gray-500 dark:text-gray-400" />
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100 flex-1">Pasting files...</p>
      </div>
      <div className="bg-gray-200 dark:bg-gray-600 rounded-full h-2">
        <div className="bg-blue-500 h-2 rounded-full transition-all duration-300" style={{ width: `${progress}%` }} />
      </div>
    </div>
  );
};
