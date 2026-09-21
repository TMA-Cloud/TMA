import React from 'react';
import { CheckCircle2, AlertTriangle, MinusCircle, HelpCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type StatusTone = 'success' | 'warning' | 'neutral' | 'unknown' | 'info';

interface StatusChipProps {
  tone: StatusTone;
  children: React.ReactNode;
  /** Overrides the tone's default icon; `null` renders text only. */
  icon?: LucideIcon | null;
  className?: string;
}

const TONES: Record<StatusTone, { icon: LucideIcon | null; className: string }> = {
  success: { icon: CheckCircle2, className: 'text-green-700 dark:text-green-400 bg-green-500/10' },
  warning: { icon: AlertTriangle, className: 'text-amber-700 dark:text-amber-400 bg-amber-500/10' },
  neutral: { icon: null, className: 'text-gray-600 dark:text-gray-300 bg-gray-500/10' },
  unknown: { icon: HelpCircle, className: 'text-gray-500 dark:text-gray-400 bg-gray-500/10' },
  info: { icon: MinusCircle, className: 'text-gray-500 dark:text-gray-400 bg-gray-500/10' },
};

/**
 * A short state label — "Up to date", "Outdated", "Configured".
 */
export const StatusChip: React.FC<StatusChipProps> = ({ tone, children, icon, className = '' }) => {
  const preset = TONES[tone];
  const Icon = icon === undefined ? preset.icon : icon;

  return (
    <span
      className={`inline-flex items-center gap-1.5 shrink-0 rounded-full px-2.5 py-1 type-caption-2 font-medium ${preset.className} ${className}`}
    >
      {Icon && <Icon className="w-3.5 h-3.5 shrink-0" />}
      {children}
    </span>
  );
};
