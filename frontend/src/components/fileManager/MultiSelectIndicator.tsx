import React from "react";
import { CheckSquare, X } from "lucide-react";

interface MultiSelectIndicatorProps {
  selectedCount: number;
  onExit: () => void;
}

export const MultiSelectIndicator: React.FC<MultiSelectIndicatorProps> = ({
  selectedCount,
  onExit,
}) => {
  return (
    <div className="bg-blue-500 text-white px-4 py-2 rounded-xl flex items-center justify-between mb-2 animate-slideDown">
      <div className="flex items-center space-x-2">
        <CheckSquare className="w-5 h-5" />
        <span className="text-sm font-medium">Multi-Select Mode</span>
        <span className="text-xs opacity-90">({selectedCount} selected)</span>
      </div>
      <button
        onClick={onExit}
        className="text-white hover:text-blue-100 active:scale-95 transition"
        aria-label="Exit multi-select mode"
      >
        <X className="w-5 h-5" />
      </button>
    </div>
  );
};
