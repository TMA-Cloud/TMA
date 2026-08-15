import React from 'react';
import { Pencil, CheckCircle2, XCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface ConfigSectionHeaderProps {
  icon: LucideIcon;
  title: string;
  description: string;
  /** Whether the section currently holds a complete configuration. */
  isConfigured: boolean;
  loading: boolean;
  saving: boolean;
  isCollapsed: boolean;
  isEditing: boolean;
  hasLoadedSettings: boolean;
  /** Names the section in the edit button's accessible label. */
  editLabel: string;
  onEdit: () => void;
}

/**
 * Header for a collapsible admin configuration section.
 *
 * While collapsed the section has to say whether it is set up without the
 * reader opening it, so the status reads as an icon-and-text chip next to the
 * title, falling back to plain text beside the description when there is no
 * icon to show (during loading).
 */
export const ConfigSectionHeader: React.FC<ConfigSectionHeaderProps> = ({
  icon: Icon,
  title,
  description,
  isConfigured,
  loading,
  saving,
  isCollapsed,
  isEditing,
  hasLoadedSettings,
  editLabel,
  onEdit,
}) => {
  const status = loading
    ? { text: 'Loading...', icon: null, color: 'text-gray-500 dark:text-gray-400' }
    : isConfigured
      ? { text: 'Configured', icon: CheckCircle2, color: 'text-green-600 dark:text-green-400' }
      : { text: 'Not configured', icon: XCircle, color: 'text-gray-500 dark:text-gray-400' };

  const StatusIcon = status.icon;
  const showStatus = isCollapsed && hasLoadedSettings;

  return (
    <div className="flex items-center gap-4 mb-6">
      <div className="p-3 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-300">
        <Icon className="w-6 h-6 icon-muted" />
      </div>

      <div className="flex-1">
        <div className="flex items-center gap-2">
          <h3 className="text-xl font-semibold text-gray-900 dark:text-gray-100 tracking-tight">{title}</h3>

          {showStatus && StatusIcon && (
            <div className={`flex items-center gap-1 ${status.color}`}>
              <StatusIcon className="w-4 h-4" />
              <span className="text-sm font-medium">{status.text}</span>
            </div>
          )}
        </div>

        <p className="text-sm text-gray-500/80 dark:text-gray-400/80 mt-0.5">
          {description}
          {showStatus && !StatusIcon && <span className={`ml-2 ${status.color}`}>{status.text}</span>}
        </p>
      </div>

      {hasLoadedSettings && (
        <button
          onClick={onEdit}
          disabled={loading || saving}
          className="p-2 rounded-lg text-gray-500 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
          aria-label={isEditing ? 'Cancel editing' : `Edit ${editLabel}`}
        >
          <Pencil className="w-5 h-5" />
        </button>
      )}
    </div>
  );
};
