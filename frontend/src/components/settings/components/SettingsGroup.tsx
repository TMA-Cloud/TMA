import React from 'react';

interface SettingsGroupProps {
  /** Eyebrow label naming what the rows below have in common. */
  title: string;
  /** One line telling the reader why these rows sit together. */
  description?: string;
  /** `danger` marks a group whose actions are hard to undo. */
  tone?: 'default' | 'danger';
  children: React.ReactNode;
}

/**
 * A labeled band of related settings rows.
 */
export const SettingsGroup: React.FC<SettingsGroupProps> = ({ title, description, tone = 'default', children }) => {
  const isDanger = tone === 'danger';

  return (
    <section
      className={
        isDanger
          ? 'rounded-2xl border border-red-500/25 dark:border-red-500/20 bg-red-50/40 dark:bg-red-950/10 px-4 py-4'
          : ''
      }
    >
      <div className="mb-3">
        <h3
          className={`type-caption-2 uppercase tracking-[0.2em] font-semibold ${
            isDanger ? 'text-red-600/90 dark:text-red-400/90' : 'text-slate-500 dark:text-slate-400'
          }`}
        >
          {title}
        </h3>
        {description && (
          <p className="type-caption text-gray-500 dark:text-gray-400 mt-1.5 max-w-prose">{description}</p>
        )}
      </div>

      <div className="space-y-2.5">{children}</div>
    </section>
  );
};
