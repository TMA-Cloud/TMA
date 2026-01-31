import React from "react";
import { User } from "lucide-react";
import { formatFileSize } from "../../../utils/fileUtils";

interface SettingsHeaderProps {
  userName?: string;
  usage?: {
    used: number;
    total: number | null;
    free: number | null;
  };
  loading?: boolean;
}

export const SettingsHeader: React.FC<SettingsHeaderProps> = ({
  userName,
  usage,
  loading,
}) => {
  const storageUsagePercent =
    usage && usage.total != null && usage.total > 0
      ? Math.min(100, Math.round((usage.used / usage.total) * 100))
      : null;

  return (
    <div
      className="relative overflow-hidden card-premium hover-lift spacing-card"
      style={{ animation: "fadeIn 0.45s ease both" }}
    >
      <div className="relative flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
        <div className="space-y-3">
          <p className="uppercase tracking-[0.35em] text-xs font-semibold text-blue-500/80">
            Control Center
          </p>
          <h1 className="text-4xl md:text-5xl font-bold text-gray-900 dark:text-gray-100 tracking-tight">
            Settings
          </h1>
          <p className="text-base md:text-lg text-gray-600/80 dark:text-gray-400/80 max-w-2xl">
            Manage your account preferences and adjust application controls
          </p>
          {userName && (
            <div className="inline-flex items-center gap-2 mt-4 px-4 py-2 rounded-full bg-blue-50/80 dark:bg-blue-900/30 text-sm font-medium text-blue-700 dark:text-blue-200 border border-blue-200/50 dark:border-blue-800/50">
              <User className="w-4 h-4 icon-muted" />
              <span>Signed in as {userName}</span>
            </div>
          )}
        </div>

        <div className="w-full md:w-1/2 space-y-3">
          <div className="flex items-center justify-between text-sm font-medium text-gray-700 dark:text-gray-300">
            <span>Storage usage</span>
            <span className="font-semibold">
              {loading || !usage
                ? "Loading..."
                : storageUsagePercent !== null
                  ? `${storageUsagePercent}%`
                  : "—"}
            </span>
          </div>
          <div className="relative h-4 w-full rounded-full bg-gray-200/80 dark:bg-gray-700/80 overflow-hidden border border-gray-300/50 dark:border-gray-600/50 shadow-inner">
            <div
              className="h-full rounded-full bg-gradient-to-r from-blue-500 via-indigo-500 to-purple-500 transition-[width] duration-300 shadow-sm"
              style={{
                width:
                  storageUsagePercent !== null && storageUsagePercent > 0
                    ? `${Math.max(storageUsagePercent, 1)}%`
                    : "0%",
              }}
            />
          </div>
          <p className="text-xs text-gray-500/80 dark:text-gray-400/80">
            {loading || !usage
              ? "Calculating storage details..."
              : usage.total != null
                ? usage.used > 0
                  ? `${formatFileSize(usage.used)} used · ${formatFileSize(usage.free ?? 0)} free of ${formatFileSize(usage.total)}`
                  : `${formatFileSize(usage.free ?? 0)} free of ${formatFileSize(usage.total)}`
                : usage.used > 0
                  ? `${formatFileSize(usage.used)} used of Unlimited`
                  : "Unlimited"}
          </p>
        </div>
      </div>
    </div>
  );
};
