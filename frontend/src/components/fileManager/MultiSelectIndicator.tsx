import React from 'react';
import { CheckSquare, X } from 'lucide-react';

interface MultiSelectIndicatorProps {
  selectedCount: number;
  onExit: () => void;
}

export const MultiSelectIndicator: React.FC<MultiSelectIndicatorProps> = ({ selectedCount, onExit }) => {
  return (
    <div className="bg-blue-500/90 dark:bg-blue-600/90 backdrop-blur-xl text-white px-4 py-3 rounded-xl flex items-center justify-between mb-3 shadow-lg border border-blue-400/30 dark:border-blue-500/30 animate-slideDown">
      <div className="flex items-center space-x-2">
        <CheckSquare className="w-5 h-5 transition-transform duration-200" />
        <span className="text-sm font-semibold">Multi-Select Mode</span>
        <span className="text-xs opacity-90">({selectedCount} selected)</span>
      </div>
      <button
        onClick={onExit}
        className="text-white hover:text-blue-100 active:scale-95 transition-all duration-200 rounded-lg p-1 hover:bg-blue-400/30"
        aria-label="Exit multi-select mode"
      >
        <X className="w-5 h-5 transition-transform duration-200" />
      </button>
    </div>
  );
};
