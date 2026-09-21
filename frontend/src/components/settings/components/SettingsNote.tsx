import React from 'react';
import { Info, AlertTriangle } from 'lucide-react';

interface SettingsNoteProps {
  children: React.ReactNode;
  tone?: 'info' | 'warning';
}

/**
 * Explanatory prose that sits among settings rows.
 */
export const SettingsNote: React.FC<SettingsNoteProps> = ({ children, tone = 'info' }) => {
  const isWarning = tone === 'warning';
  const Icon = isWarning ? AlertTriangle : Info;

  return (
    <div
      className={`flex items-start gap-2.5 rounded-xl px-4 py-3 ${
        isWarning
          ? 'border border-amber-300/60 dark:border-amber-700/60 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-200'
          : 'border border-slate-200/50 dark:border-slate-700/30 bg-white/40 dark:bg-gray-900/30 text-gray-500 dark:text-gray-400'
      }`}
    >
      <Icon className="w-4 h-4 shrink-0 mt-0.5" />
      <p className="type-caption max-w-prose">{children}</p>
    </div>
  );
};
