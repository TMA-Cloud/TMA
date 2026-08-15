import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { clampPercent } from './progressUtils';

type ProgressVariant = 'neutral' | 'emerald' | 'blue-pulse';

// The variants differ only in their icon and bar colour; the card body is the
// same in every case, which is why there is no per-variant container class.
const CONTAINER_CLASS = 'bg-[var(--surface)] border border-[var(--separator)] rounded-lg shadow-lg';

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

interface ProgressCardProps {
  icon: LucideIcon;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  percent?: number | null;
  showPercentBadge?: boolean;
  variant?: ProgressVariant;
  /** Container styling. Defaults to the standalone toast surface. */
  className?: string;
}

/**
 * One progress row: icon, title, optional subtitle, and a bar.
 *
 * Positioning is deliberately not included — a single toast pins itself to the
 * bottom of the viewport, while the desktop-open list stacks several of these
 * inside one container. Both need the same row.
 *
 * Omitting `percent` (or passing null) means "indeterminate": the bar fills and
 * pulses instead of tracking a value.
 */
export const ProgressCard: React.FC<ProgressCardProps> = ({
  icon: Icon,
  title,
  subtitle,
  percent,
  showPercentBadge = false,
  variant = 'neutral',
  className = CONTAINER_CLASS,
}) => {
  const safePercent = clampPercent(percent);
  const animate = percent === undefined || percent === null;

  return (
    <div className={`w-80 p-4 ${className}`}>
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

type FixedProgressProps = Omit<ProgressCardProps, 'className'>;

/** A single progress card pinned to the bottom centre of the viewport. */
export const FixedProgress: React.FC<FixedProgressProps> = props => (
  <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50">
    <ProgressCard {...props} />
  </div>
);
