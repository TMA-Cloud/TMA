import React from 'react';
import { Check } from 'lucide-react';
import type { PermissionDefinition } from '../../../utils/api';

interface PermissionChecklistProps {
  /** Capabilities the server offers, in the order it wants them shown. */
  available: PermissionDefinition[];
  /** Currently granted keys. */
  value: string[];
  onChange: (permissions: string[]) => void;
  disabled?: boolean;
  /** Prefix for input ids so several checklists can coexist on one screen. */
  idPrefix: string;
}

/**
 * Allow-list of capabilities, laid out like the Windows security tab: one row
 * per permission with a tick box, so an owner can see at a glance exactly what
 * a sub-user may and may not do.
 *
 * Anything not ticked is denied — there is no separate Deny column because
 * there is no inheritance to override, so a second column would only ever
 * duplicate the inverse of the first.
 */
export const PermissionChecklist: React.FC<PermissionChecklistProps> = ({
  available,
  value,
  onChange,
  disabled = false,
  idPrefix,
}) => {
  const toggle = (key: string) => {
    if (disabled) return;
    // Preserve the catalog's order so the stored list is stable regardless of
    // the order the boxes happened to be ticked in.
    const next = new Set(value);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    onChange(available.filter(p => next.has(p.key)).map(p => p.key));
  };

  const allKeys = available.map(p => p.key);
  const allChecked = allKeys.length > 0 && allKeys.every(key => value.includes(key));
  const noneChecked = value.length === 0;

  return (
    <div className="rounded-xl border border-slate-200/70 dark:border-slate-700/50 overflow-hidden">
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 bg-slate-100/70 dark:bg-slate-800/60 border-b border-slate-200/70 dark:border-slate-700/50">
        <span className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500 dark:text-slate-400">
          Permissions
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={disabled || allChecked}
            onClick={() => onChange(allKeys)}
            className="text-xs px-2.5 py-1 rounded-lg border border-blue-500/40 text-blue-600 dark:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Allow all
          </button>
          <button
            type="button"
            disabled={disabled || noneChecked}
            onClick={() => onChange([])}
            className="text-xs px-2.5 py-1 rounded-lg border border-slate-300 dark:border-slate-600 text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-700/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Clear all
          </button>
        </div>
      </div>

      <ul className="divide-y divide-slate-200/60 dark:divide-slate-700/40">
        {available.map(permission => {
          const checked = value.includes(permission.key);
          const inputId = `${idPrefix}-${permission.key}`;

          return (
            <li key={permission.key}>
              <label
                htmlFor={inputId}
                className={`flex items-start gap-3 px-4 py-3 transition-colors ${
                  disabled
                    ? 'cursor-not-allowed opacity-60'
                    : 'cursor-pointer hover:bg-slate-100/60 dark:hover:bg-slate-800/40'
                }`}
              >
                <span className="relative flex items-center justify-center mt-0.5 shrink-0">
                  <input
                    id={inputId}
                    type="checkbox"
                    className="peer sr-only"
                    checked={checked}
                    disabled={disabled}
                    onChange={() => toggle(permission.key)}
                  />
                  <span
                    aria-hidden
                    className={`w-5 h-5 rounded-md border flex items-center justify-center transition-all duration-150 peer-focus-visible:ring-2 peer-focus-visible:ring-[#5b8def]/50 peer-focus-visible:ring-offset-1 dark:peer-focus-visible:ring-offset-slate-900 ${
                      checked
                        ? 'bg-gradient-to-br from-[#5b8def] to-[#4a7edb] border-transparent'
                        : 'border-slate-300 dark:border-slate-600 bg-white/70 dark:bg-slate-700/50'
                    }`}
                  >
                    {checked && <Check className="w-3.5 h-3.5 text-white" strokeWidth={3} />}
                  </span>
                </span>

                <span className="min-w-0">
                  <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">{permission.label}</span>
                  <span className="block text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {permission.description}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      {noneChecked && (
        <p className="px-4 py-2.5 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 border-t border-amber-200/70 dark:border-amber-800/40">
          With nothing ticked this person can browse and search but cannot download or change anything
        </p>
      )}
    </div>
  );
};
