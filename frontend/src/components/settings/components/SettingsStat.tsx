import React from 'react';
import type { LucideIcon } from 'lucide-react';

interface SettingsStatProps {
  label: string;
  /** The figure itself — already formatted, or null while it is unknown. */
  value: string | number | null;
  /** A short gloss under the figure: what it counts, or how fresh it is. */
  hint?: string;
  icon: LucideIcon;
  loading?: boolean;
}

/**
 * A read-only figure, shown as a tile rather than a settings row.
 */
export const SettingsStat: React.FC<SettingsStatProps> = ({ label, value, hint, icon: Icon, loading }) => {
  const display = loading ? '—' : value === null ? 'Unavailable' : value;

  return (
    <div className="stagger-item rounded-xl bg-white/60 dark:bg-gray-900/50 border border-slate-200/50 dark:border-slate-700/30 px-4 py-3.5">
      <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
        <Icon className="w-4 h-4 shrink-0 icon-muted" />
        <p className="type-caption">{label}</p>
      </div>
      <p
        className={`mt-2 text-gray-900 dark:text-gray-100 ${
          typeof display === 'number' || /^\d/.test(String(display)) ? 'type-title-2' : 'type-headline'
        } ${loading ? 'text-gray-400 dark:text-gray-600' : ''}`}
      >
        {display}
      </p>
      {hint && <p className="type-caption-2 text-gray-400 dark:text-gray-500 mt-1">{hint}</p>}
    </div>
  );
};
