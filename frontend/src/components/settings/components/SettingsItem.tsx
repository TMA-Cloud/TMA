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
    <div className="stagger-item hover-lift flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between rounded-2xl bg-[#d4d9e1] dark:bg-gray-900/60 border border-black/[0.08] dark:border-transparent px-5 py-4 border border-transparent hover:border-blue-500/40 transition-all duration-200">
      <div>
        <p className="text-base font-medium text-gray-900 dark:text-gray-100">{label}</p>
        {description && <p className="text-base text-gray-500 dark:text-gray-400 mt-0.5">{description}</p>}
      </div>

      {toggle !== undefined ? (
        <div className="flex flex-col items-end">
          <button
            onClick={onToggle}
            disabled={toggleDisabled}
            className={`
              relative inline-flex h-7 w-14 items-center rounded-full transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500
              ${toggleValue ? 'bg-gradient-to-r from-blue-500 to-indigo-500' : 'bg-gray-200 dark:bg-gray-700'}
              ${toggleDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
            `}
            aria-label={label}
          >
            <span
              className={`
                inline-block h-5 w-5 transform rounded-full bg-[#d4d9e1] shadow-sm transition-transform duration-200
                ${toggleValue ? 'translate-x-8' : 'translate-x-1'}
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
                  inline-flex items-center gap-2.5 px-5 py-2.5 text-base rounded-2xl transition-all duration-200 border
                  ${
                    isDisabled
                      ? 'bg-gray-200 dark:bg-gray-700 cursor-not-allowed opacity-70 border-transparent'
                      : isDanger
                        ? 'border-red-500/40 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30'
                        : 'border-blue-500/40 text-blue-600 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/30'
                  }
                `}
              >
                {showLoader ? <Loader2 className="w-5 h-5 animate-spin" /> : <ActionIcon className="w-5 h-5" />}
                <span>{action}</span>
              </button>
            );
          })()}
        </div>
      ) : (
        <span className="text-lg font-semibold text-gray-700 dark:text-gray-200 text-left sm:text-right break-words">
          {value}
        </span>
      )}
    </div>
  );
};
