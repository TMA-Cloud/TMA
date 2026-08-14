import React from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';

interface SettingsItemProps {
  label: string;
  value?: string;
  description?: string;
  toggle?: boolean;
  toggleValue?: boolean;
  onToggle?: () => void;
  toggleDisabled?: boolean;
  action?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
  actionIcon?: React.ComponentType<{ className?: string }>;
  actionVariant?: 'default' | 'danger';
  loadingStates?: {
    usersList?: boolean;
    sessions?: boolean;
    logoutAll?: boolean;
  };
}

export const SettingsItem: React.FC<SettingsItemProps> = ({
  label,
  value,
  description,
  toggle,
  toggleValue,
  onToggle,
  toggleDisabled,
  action,
  onAction,
  actionDisabled,
  actionIcon: ActionIcon = ChevronRight,
  actionVariant = 'default',
  loadingStates,
}) => {
  return (
    <div className="stagger-item hover-lift flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between rounded-xl bg-white/60 dark:bg-gray-900/50 border border-slate-200/50 dark:border-slate-700/30 px-4 py-3 hover:border-blue-500/30 dark:hover:border-blue-500/30 transition-all duration-200">
      <div>
        <p className="type-callout font-medium text-gray-900 dark:text-gray-100">{label}</p>
        {/* A step down from the label: the description is context, never the thing being scanned for. */}
        {description && (
          <p className="type-caption text-gray-500 dark:text-gray-400 mt-0.5 max-w-prose">{description}</p>
        )}
      </div>

      {toggle !== undefined ? (
        <div className="flex flex-col items-end">
          <button
            onClick={onToggle}
            disabled={toggleDisabled}
            className={`
              relative inline-flex h-6 w-11 items-center rounded-full transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500
              ${toggleValue ? 'bg-[var(--accent)]' : 'bg-gray-200 dark:bg-gray-700'}
              ${toggleDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
            `}
            aria-label={label}
          >
            <span
              className={`
                inline-block h-4 w-4 transform rounded-full bg-[#f9f9fb] shadow-sm transition-transform duration-200
                ${toggleValue ? 'translate-x-6' : 'translate-x-1'}
              `}
            />
          </button>
        </div>
      ) : action !== undefined ? (
        <div className="flex flex-col items-end">
          {(() => {
            const isDanger = actionVariant === 'danger';
            const isDisabled = actionDisabled || !(onAction && typeof onAction === 'function');

            const showLoader =
              (label === 'Registered Users' && loadingStates?.usersList) ||
              (label === 'Active Sessions' && loadingStates?.sessions) ||
              (label === 'Logout All Devices' && loadingStates?.logoutAll);

            return (
              <button
                onClick={onAction}
                disabled={isDisabled}
                className={`
                  inline-flex items-center gap-2 px-3.5 py-1.5 type-footnote rounded-xl transition-all duration-200 border
                  ${
                    isDisabled
                      ? 'bg-gray-200 dark:bg-gray-700 cursor-not-allowed opacity-70 border-transparent'
                      : isDanger
                        ? 'border-red-500/40 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30'
                        : 'border-blue-500/40 text-blue-600 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/30'
                  }
                `}
              >
                {showLoader ? <Loader2 className="w-4 h-4 animate-spin" /> : <ActionIcon className="w-4 h-4" />}
                <span>{action}</span>
              </button>
            );
          })()}
        </div>
      ) : (
        <span className="type-callout font-semibold text-gray-700 dark:text-gray-200 text-left sm:text-right break-words">
          {value}
        </span>
      )}
    </div>
  );
};
