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
      className="relative overflow-hidden card-premium hover-lift spacing-card rounded-2xl bg-[#f0f3f7] dark:bg-slate-800/80 border border-slate-200/60 dark:border-slate-700/50"
      style={{ animation: 'fadeIn 0.45s ease both' }}
    >
      <div className="relative flex flex-col gap-8 md:flex-row md:items-center md:justify-between">
        <div className="space-y-4">
          <p className="uppercase tracking-[0.35em] text-sm font-semibold text-[#5b8def]/90">Control Center</p>
          <h1 className="text-4xl md:text-6xl font-bold text-slate-800 dark:text-slate-100 tracking-tight">Settings</h1>
          <p className="text-lg md:text-xl text-slate-600 dark:text-slate-400 max-w-2xl">
            Manage your account preferences and adjust application controls
          </p>
          {userName && (
            <div className="inline-flex items-center gap-2.5 mt-5 px-5 py-2.5 rounded-2xl bg-[#5b8def]/10 dark:bg-[#5b8def]/20 text-base font-medium text-[#4a7edb] dark:text-blue-300 border border-[#5b8def]/20 dark:border-[#5b8def]/30">
              <User className="w-5 h-5 icon-muted" />
              <span>Signed in as {userName}</span>
            </div>
          )}
        </div>

        <div className="w-full md:w-1/2 space-y-4">
          <div className="flex items-center justify-between text-base font-medium text-slate-700 dark:text-slate-300">
            <span>Storage usage</span>
            <span className="font-semibold text-lg">
              {loading || !usage ? 'Loading...' : storageUsagePercent !== null ? `${storageUsagePercent}%` : '—'}
            </span>
          </div>
          <div className="relative h-5 w-full rounded-full bg-slate-200/80 dark:bg-slate-700/80 overflow-hidden border border-slate-200/60 dark:border-slate-600/50">
            <div
              className="h-full rounded-full bg-gradient-to-r from-[#5b8def] via-[#7c6ef6] to-[#a78bfa] transition-[width] duration-300 ease-out"
              style={{
                width:
                  storageUsagePercent !== null && storageUsagePercent > 0
                    ? `${Math.max(storageUsagePercent, 1)}%`
                    : '0%',
              }}
            />
          </div>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {loading || !usage
              ? 'Calculating storage details...'
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
