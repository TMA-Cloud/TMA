import React from 'react';

/**
 * Shared header row used at the top of list modals (Users, Sessions, ActiveClients):
 * a pluralized count label on the left and a Refresh button on the right.
 */
export const ModalCountHeader: React.FC<{
  count: number;
  singular: string;
  plural?: string;
  /** Suffix appended to the count, e.g. " total". */
  countSuffix?: string;
  /** Shown when count === 0. */
  emptyText: string;
  loading?: boolean;
  onRefresh: () => void;
}> = ({ count, singular, plural, countSuffix = '', emptyText, loading, onRefresh }) => {
  const noun = count === 1 ? singular : (plural ?? `${singular}s`);
  return (
    <div className="flex items-center justify-between">
      <p className="text-sm text-gray-600 dark:text-gray-300">
        {count > 0 ? `${count} ${noun}${countSuffix}` : emptyText}
      </p>
      <button
        onClick={onRefresh}
        disabled={loading}
        className={`
          px-3 py-1 text-sm rounded-lg transition-colors duration-200 border
          ${
            loading
              ? 'border-gray-300 dark:border-gray-600 text-gray-400 cursor-not-allowed'
              : 'border-blue-500 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20'
          }
        `}
      >
        {loading ? 'Refreshing...' : 'Refresh'}
      </button>
    </div>
  );
};
