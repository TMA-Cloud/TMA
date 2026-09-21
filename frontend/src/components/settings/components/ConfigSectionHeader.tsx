import React from 'react';
import { ChevronDown } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { StatusChip, type StatusTone } from './StatusChip';

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
  /** Names the section in the header's accessible label. */
  editLabel: string;
  onEdit: () => void;
  /**
   * Replaces the Configured / Not set up chip when the section has a more
   * useful thing to report — a current value, say, rather than a yes/no.
   */
  status?: { text: string; tone: StatusTone };
}

/**
 * Header for a collapsible admin configuration section.
 *
 * The whole header is the control: a pencil sitting alone at the end of a row
 * asks the reader to guess that the row opens, whereas a row that is itself a
 * button with a chevron says so. The status chip stays visible while collapsed
 * so the section reports whether it is set up without being opened.
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
  status,
}) => {
  const resolvedStatus: { text: string; tone: StatusTone } = loading
    ? { text: 'Loading...', tone: 'neutral' }
    : (status ?? (isConfigured ? { text: 'Configured', tone: 'success' } : { text: 'Not set up', tone: 'info' }));

  const disabled = !hasLoadedSettings || loading || saving;

  return (
    <button
      type="button"
      onClick={onEdit}
      disabled={disabled}
      aria-expanded={!isCollapsed}
      aria-label={isEditing ? `Stop editing ${editLabel}` : `Edit ${editLabel}`}
      className={`
        w-full flex items-center gap-3 text-left rounded-xl px-1 py-1 -mx-1
        transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500
        ${disabled ? 'cursor-default opacity-80' : 'cursor-pointer hover:bg-slate-500/5 dark:hover:bg-slate-400/5'}
      `}
    >
      <div className="p-2.5 rounded-xl bg-blue-500/10 text-blue-600 dark:text-blue-300 shrink-0">
        <Icon className="w-5 h-5 icon-muted" />
      </div>

      <div className="flex-1 min-w-0">
        <p className="type-callout font-medium text-gray-900 dark:text-gray-100 truncate">{title}</p>
        <p className="type-caption text-gray-500 dark:text-gray-400 mt-0.5">{description}</p>
      </div>

      {hasLoadedSettings && (
        <StatusChip tone={resolvedStatus.tone} className="hidden sm:inline-flex">
          {resolvedStatus.text}
        </StatusChip>
      )}

      <ChevronDown
        className={`w-5 h-5 shrink-0 text-gray-400 dark:text-gray-500 transition-motion duration-200 ${
          isCollapsed ? '' : 'rotate-180'
        }`}
      />
    </button>
  );
};
