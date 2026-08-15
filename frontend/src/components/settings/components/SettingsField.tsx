import React from 'react';

/**
 * Shared card wrapper for a labeled settings field (input or readonly value).
 * Used inside expanded settings sections to keep the rounded-xl + hover-border
 * look consistent across ShareBaseUrl / OnlyOffice / Storage.
 */
export const SettingsField: React.FC<{
  htmlFor?: string;
  label: string;
  description?: string;
  children: React.ReactNode;
}> = ({ htmlFor, label, description, children }) => {
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-white/60 dark:bg-gray-900/50 border border-slate-200/50 dark:border-slate-700/30 px-4 py-3 hover:border-blue-500/30 transition-all duration-200">
      {htmlFor ? (
        <label htmlFor={htmlFor} className="type-callout font-medium text-gray-900 dark:text-gray-100">
          {label}
        </label>
      ) : (
        <label className="type-callout font-medium text-gray-900 dark:text-gray-100">{label}</label>
      )}
      {description && <p className="type-caption text-gray-500 dark:text-gray-400">{description}</p>}
      {children}
    </div>
  );
};

/**
 * Readonly pill used inside SettingsField when not editing.
 * Handles loading, empty and filled states with consistent styles.
 */
export const SettingsReadonlyValue: React.FC<{
  loading?: boolean;
  value: React.ReactNode;
  emptyText?: string;
}> = ({ loading, value, emptyText = 'Not configured' }) => {
  return (
    <div className="mt-1 px-3 py-2 type-footnote rounded-lg border border-gray-300 dark:border-gray-600 bg-gray-100 dark:bg-gray-800/50 text-gray-900 dark:text-gray-100">
      {loading ? (
        <span className="text-gray-500 dark:text-gray-400">Loading...</span>
      ) : value ? (
        value
      ) : (
        <span className="text-gray-400 dark:text-gray-500 italic">{emptyText}</span>
      )}
    </div>
  );
};

/**
 * Cancel/Save button pair used at the bottom of editable settings sections.
 */
export const SettingsFormActions: React.FC<{
  onCancel: () => void;
  onSave: () => void;
  saving?: boolean;
  disabled?: boolean;
  saveLabel?: string;
  savingLabel?: string;
}> = ({ onCancel, onSave, saving, disabled, saveLabel = 'Save Settings', savingLabel = 'Saving...' }) => {
  return (
    <div className="flex justify-end gap-2">
      <button
        type="button"
        onClick={onCancel}
        disabled={disabled}
        className="px-4 py-2 type-footnote font-medium rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 bg-[#ffffff] dark:bg-gray-800 hover:bg-[#f9f9f7] dark:hover:bg-gray-700 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2"
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={onSave}
        disabled={disabled}
        className="px-6 py-2 type-footnote font-medium rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
      >
        {saving ? savingLabel : saveLabel}
      </button>
    </div>
  );
};
