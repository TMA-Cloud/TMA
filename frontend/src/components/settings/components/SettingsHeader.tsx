import React from 'react';
import { User } from 'lucide-react';
import { formatFileSize } from '../../../utils/fileUtils';

interface SettingsHeaderProps {
  userName?: string;
  usage?: {
    used: number;
    total: number | null;
    free: number | null;
  };
  loading?: boolean;
}

export const SettingsHeader: React.FC<SettingsHeaderProps> = ({ userName, usage, loading }) => {
  const storageUsagePercent =
    usage && usage.total != null && usage.total > 0
      ? Math.min(100, Math.round((usage.used / usage.total) * 100))
      : null;

  return (
    <div
      className="relative overflow-hidden card-premium hover-lift spacing-card rounded-2xl bg-[#ffffff] dark:bg-slate-800/80 border border-slate-200/60 dark:border-slate-700/50"
      style={{ animation: 'fadeIn 0.45s ease both' }}
    >
      <div className="relative flex flex-col gap-8 md:flex-row md:items-center md:justify-between">
        <div className="space-y-4">
          <p className="uppercase tracking-[0.28em] type-caption-2 font-semibold text-[#007aff]/90">Control Center</p>
          <h1 className="type-title-2 text-slate-800 dark:text-slate-100">Settings</h1>
          <p className="type-footnote text-slate-600 dark:text-slate-400 max-w-md">
            Account, security, and workspace preferences
          </p>
          {userName && (
            <div className="inline-flex items-center gap-2 mt-4 px-3.5 py-1.5 rounded-full bg-[#007aff]/10 dark:bg-[#007aff]/20 type-caption font-medium text-[#0069e0] dark:text-blue-300 border border-[#007aff]/20 dark:border-[#007aff]/30">
              <User className="w-3.5 h-3.5 icon-muted" />
              <span>Signed in as {userName}</span>
            </div>
          )}
        </div>

        <div className="w-full md:w-1/2 space-y-2.5">
          <div className="flex items-center justify-between type-footnote font-medium text-slate-700 dark:text-slate-300">
            <span>Storage usage</span>
            <span className="font-semibold">
              {loading || !usage ? 'Loading...' : storageUsagePercent !== null ? `${storageUsagePercent}%` : '—'}
            </span>
          </div>
          <div className="relative h-2.5 w-full rounded-full bg-slate-200/80 dark:bg-slate-700/80 overflow-hidden border border-slate-200/60 dark:border-slate-600/50">
            <div
              className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300 ease-out"
              style={{
                width:
                  storageUsagePercent !== null && storageUsagePercent > 0
                    ? `${Math.max(storageUsagePercent, 1)}%`
                    : '0%',
              }}
            />
          </div>
          <p className="type-caption text-slate-500 dark:text-slate-400">
            {loading || !usage
              ? 'Calculating…'
              : usage.total != null
                ? usage.used > 0
                  ? `${formatFileSize(usage.used)} used · ${formatFileSize(usage.free ?? 0)} free of ${formatFileSize(usage.total)}`
                  : `${formatFileSize(usage.free ?? 0)} free of ${formatFileSize(usage.total)}`
                : usage.used > 0
                  ? `${formatFileSize(usage.used)} used of Unlimited`
                  : 'Unlimited'}
          </p>
        </div>
      </div>
    </div>
  );
};
