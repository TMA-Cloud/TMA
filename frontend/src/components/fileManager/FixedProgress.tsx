import React from 'react';
import type { LucideIcon } from 'lucide-react';

type ProgressVariant = 'neutral' | 'emerald' | 'blue-pulse';

interface FixedProgressProps {
  icon: LucideIcon;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  percent?: number | null;
  showPercentBadge?: boolean;
  variant?: ProgressVariant;
}

const containerByVariant: Record<ProgressVariant, string> = {
  neutral: 'bg-[#ffffff] dark:bg-gray-800 border border-gray-200 dark:border-gray-700',
  emerald: 'bg-[#f2f2f7] dark:bg-gray-800 border border-emerald-200/70 dark:border-gray-700',
  'blue-pulse': 'bg-[#ffffff] dark:bg-gray-800 border border-gray-200 dark:border-gray-700',
};

const iconColorByVariant: Record<ProgressVariant, string> = {
  neutral: 'text-gray-500 dark:text-gray-400',
  emerald: 'text-emerald-600 dark:text-emerald-400',
  'blue-pulse': 'text-gray-500 dark:text-gray-400',
};

const barColorByVariant: Record<ProgressVariant, string> = {
  neutral: 'bg-red-500',
  emerald: 'bg-emerald-500',
  'blue-pulse': 'bg-blue-500',
};

function clampPercent(value: number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

export const FixedProgress: React.FC<FixedProgressProps> = ({
  icon: Icon,
  title,
  subtitle,
  percent,
  showPercentBadge = false,
  variant = 'neutral',
}) => {
  const safePercent = clampPercent(percent);
  const animate = percent === undefined || percent === null;

  return (
    <div
      className={`fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-80 rounded-lg shadow-lg p-4 ${containerByVariant[variant]}`}
    >
      <div className="flex items-center space-x-2 mb-2">
        <Icon className={`w-4 h-4 ${iconColorByVariant[variant]}`} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">{title}</p>
          {subtitle && <p className="text-xs text-gray-600 dark:text-gray-400">{subtitle}</p>}
        </div>
        {showPercentBadge && (
          <span className="text-xs font-medium text-gray-600 dark:text-gray-300">{safePercent}%</span>
        )}
      </div>
      <div className="bg-gray-200 dark:bg-gray-600 rounded-full h-2">
        <div
          className={`${barColorByVariant[variant]} h-2 rounded-full ${
            animate ? 'animate-pulse' : 'transition-all duration-200'
          }`}
          style={{ width: `${animate ? 100 : safePercent}%` }}
        />
      </div>
    </div>
  );
};
