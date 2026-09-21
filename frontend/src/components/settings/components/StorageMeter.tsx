import React from 'react';
import { formatFileSize } from '../../../utils/fileUtils';

interface StorageMeterProps {
  used: number;
  /** `null` means no quota is set, so there is no proportion to draw. */
  total: number | null;
  free: number | null;
  loading?: boolean;
}

/** Amber once the account is nearly full, red once it effectively is. */
function barTone(percent: number): string {
  if (percent >= 95) return 'bg-red-500';
  if (percent >= 80) return 'bg-amber-500';
  return 'bg-[var(--accent)]';
}

/**
 * How much of the quota is gone, as a determinate bar.
 *
 * Usage used to be two text rows — "Used Space", "Available Space" — which
 * makes the reader do the division themselves. A bar answers "am I running
 * out?" at a glance. When no quota is set there is nothing to be a proportion
 * of, so the bar is omitted rather than drawn empty at 0%.
 */
export const StorageMeter: React.FC<StorageMeterProps> = ({ used, total, free, loading }) => {
  const hasQuota = total !== null && total > 0;
  const rawPercent = hasQuota ? (used / total) * 100 : 0;
  const percent = Math.min(100, Math.floor(rawPercent));

  if (loading) {
    return (
      <div className="rounded-2xl bg-white/60 dark:bg-gray-900/50 border border-slate-200/50 dark:border-slate-700/30 px-5 py-5">
        <p className="type-caption text-gray-500 dark:text-gray-400">Calculating storage usage...</p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-white/60 dark:bg-gray-900/50 border border-slate-200/50 dark:border-slate-700/30 px-5 py-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="type-title-2 text-gray-900 dark:text-gray-100">{formatFileSize(used)}</p>
        <p className="type-footnote text-gray-500 dark:text-gray-400">
          {hasQuota ? `of ${formatFileSize(total)} used` : 'used — no quota set'}
        </p>
      </div>

      {hasQuota && (
        <>
          <div
            className="mt-3 h-2 w-full rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label="Storage used"
          >
            <div
              className={`h-full rounded-full transition-[width] duration-500 ${barTone(rawPercent)}`}
              style={{ width: `${Math.max(percent, used > 0 ? 1 : 0)}%` }}
            />
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 type-caption text-gray-500 dark:text-gray-400">
            <span>{percent}% full</span>
            <span>{free !== null ? `${formatFileSize(free)} free` : 'Unlimited space remaining'}</span>
          </div>
        </>
      )}

      {!hasQuota && (
        <p className="mt-2 type-caption text-gray-500 dark:text-gray-400">
          This account has no storage limit, so there is nothing to fill up.
        </p>
      )}
    </div>
  );
};
