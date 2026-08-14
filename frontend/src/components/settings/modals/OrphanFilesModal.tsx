import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Database, HardDrive, Loader2, ShieldCheck, Trash2 } from 'lucide-react';
import { format } from 'date-fns';
import { Modal } from '../../ui/Modal';
import { formatFileSize } from '../../../utils/fileUtils';
import { deleteOrphans, fetchOrphans, type OrphanReport } from '../../../utils/api';
import { useToast } from '../../../hooks/useToast';

interface OrphanFilesModalProps {
  isOpen: boolean;
  onClose: () => void;
}

type TabId = 'storage' | 'database';

/**
 * Grace window choices. The floor of 1 hour is enforced by the backend too —
 * anything newer than the window may still be an upload or paste in progress,
 * so it is never offered for deletion.
 */
const GRACE_OPTIONS = [
  { minutes: 60, label: '1 hour' },
  { minutes: 6 * 60, label: '6 hours' },
  { minutes: 24 * 60, label: '24 hours' },
  { minutes: 7 * 24 * 60, label: '7 days' },
  { minutes: 30 * 24 * 60, label: '30 days' },
];

const DEFAULT_GRACE_MINUTES = 24 * 60;

function formatDate(value: string | null): string {
  if (!value) return 'Unknown';
  try {
    return format(new Date(value), "MMM d, yyyy 'at' h:mm a");
  } catch {
    return 'Unknown';
  }
}

export const OrphanFilesModal: React.FC<OrphanFilesModalProps> = ({ isOpen, onClose }) => {
  const { showToast } = useToast();
  // ToastProvider hands out a fresh showToast on every one of its renders.
  // Reading it through a ref keeps loadReport stable, so an unrelated toast
  // elsewhere in the app cannot re-trigger the scan and wipe the selection.
  const showToastRef = useRef(showToast);
  useEffect(() => {
    showToastRef.current = showToast;
  });

  const [graceMinutes, setGraceMinutes] = useState(DEFAULT_GRACE_MINUTES);
  const [report, setReport] = useState<OrphanReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('storage');

  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [skippedNotes, setSkippedNotes] = useState<string[]>([]);

  const clearSelection = useCallback(() => {
    setSelectedKeys(new Set());
    setSelectedIds(new Set());
    setConfirming(false);
  }, []);

  const loadReport = useCallback(
    async (minutes: number) => {
      setLoading(true);
      setError(null);
      setSkippedNotes([]);
      clearSelection();
      try {
        setReport(await fetchOrphans(minutes));
      } catch {
        setReport(null);
        setError('Unable to scan for orphaned files right now');
        showToastRef.current('Failed to scan for orphaned files', 'error');
      } finally {
        setLoading(false);
      }
    },
    [clearSelection]
  );

  // Re-scan when the modal opens or the grace window changes. Deferred off the
  // effect body so the scan's state updates do not cascade into this render.
  useEffect(() => {
    if (isOpen) Promise.resolve().then(() => loadReport(graceMinutes));
  }, [isOpen, graceMinutes, loadReport]);

  const storageItems = useMemo(() => report?.storageOrphans.items ?? [], [report]);
  const databaseItems = useMemo(() => report?.databaseOrphans.items ?? [], [report]);

  const selectedCount = selectedKeys.size + selectedIds.size;

  const selectedBytes = useMemo(() => {
    let bytes = 0;
    for (const item of storageItems) if (selectedKeys.has(item.key)) bytes += item.size;
    for (const item of databaseItems) if (selectedIds.has(item.id)) bytes += item.size;
    return bytes;
  }, [storageItems, databaseItems, selectedKeys, selectedIds]);

  const toggleKey = (key: string) => {
    setConfirming(false);
    setSelectedKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleId = (id: string) => {
    setConfirming(false);
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const currentItemCount = activeTab === 'storage' ? storageItems.length : databaseItems.length;
  const currentSelectedCount = activeTab === 'storage' ? selectedKeys.size : selectedIds.size;
  const allCurrentSelected = currentItemCount > 0 && currentSelectedCount === currentItemCount;

  const toggleSelectAll = () => {
    setConfirming(false);
    if (activeTab === 'storage') {
      setSelectedKeys(allCurrentSelected ? new Set() : new Set(storageItems.map(i => i.key)));
    } else {
      setSelectedIds(allCurrentSelected ? new Set() : new Set(databaseItems.map(i => i.id)));
    }
  };

  const handleDelete = async () => {
    if (selectedCount === 0) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }

    setDeleting(true);
    setConfirming(false);
    try {
      const result = await deleteOrphans({
        storageKeys: [...selectedKeys],
        fileIds: [...selectedIds],
        graceMinutes,
      });

      const deleted = result.storage.deleted + result.database.deleted;
      const skipped = result.storage.skipped + result.database.skipped;

      const notes = [
        ...result.storage.results.filter(r => !r.deleted).map(r => `${r.key}: ${r.reason ?? 'Skipped'}`),
        ...result.database.results.filter(r => !r.deleted).map(r => `${r.id}: ${r.reason ?? 'Skipped'}`),
      ];

      if (deleted > 0) {
        showToast(
          skipped > 0
            ? `Deleted ${deleted} ${deleted === 1 ? 'orphan' : 'orphans'}, skipped ${skipped}`
            : `Deleted ${deleted} ${deleted === 1 ? 'orphan' : 'orphans'}`,
          skipped > 0 ? 'info' : 'success'
        );
      } else {
        showToast('Nothing deleted — every entry still checks out', 'info');
      }

      // Rescan clears the notes, so restate them once the fresh report is in.
      await loadReport(graceMinutes);
      setSkippedNotes(notes);
    } catch {
      showToast('Failed to delete orphaned entries', 'error');
    } finally {
      setDeleting(false);
    }
  };

  const handleClose = () => {
    clearSelection();
    setSkippedNotes([]);
    onClose();
  };

  const renderRow = (
    checked: boolean,
    onToggle: () => void,
    title: string,
    subtitle: React.ReactNode,
    meta: string,
    badge?: React.ReactNode
  ) => (
    <label
      className={`
        flex items-start gap-3 p-3.5 rounded-xl border cursor-pointer transition-colors duration-150
        ${
          checked
            ? 'bg-red-50 dark:bg-red-900/15 border-red-300 dark:border-red-800'
            : 'bg-[#ffffff]/95 dark:bg-gray-900/60 border-gray-200 dark:border-gray-700 hover:border-blue-400/60'
        }
      `}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="mt-1 w-4 h-4 shrink-0 accent-red-600 cursor-pointer"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100 break-all">{title}</p>
          {badge}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 space-y-0.5 break-all">{subtitle}</div>
      </div>
      <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap shrink-0 pt-0.5">{meta}</span>
    </label>
  );

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Orphaned Files" size="xl">
      <div className="space-y-4">
        {/* What this is and why nothing runs on its own */}
        <div className="flex gap-3 p-4 rounded-xl bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
          <ShieldCheck className="w-5 h-5 shrink-0 text-blue-600 dark:text-blue-400 mt-0.5" />
          <div className="text-xs text-blue-900 dark:text-blue-200 space-y-1">
            <p className="font-semibold text-sm">Nothing is deleted automatically</p>
            <p>Orphans are only removed when you select them here..!!</p>
          </div>
        </div>

        {/* Grace window + scan summary */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="flex items-center gap-2">
            <label htmlFor="orphan-grace" className="text-sm text-gray-600 dark:text-gray-300">
              Ignore anything newer than
            </label>
            <select
              id="orphan-grace"
              value={graceMinutes}
              onChange={e => setGraceMinutes(Number(e.target.value))}
              disabled={loading || deleting}
              className="px-3 py-1.5 text-sm rounded-lg bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 text-gray-800 dark:text-gray-200 disabled:opacity-50"
            >
              {GRACE_OPTIONS.map(option => (
                <option key={option.minutes} value={option.minutes}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <button
            onClick={() => loadReport(graceMinutes)}
            disabled={loading || deleting}
            className={`
              px-3 py-1.5 text-sm rounded-lg border transition-colors duration-200
              ${
                loading || deleting
                  ? 'border-gray-300 dark:border-gray-600 text-gray-400 cursor-not-allowed'
                  : 'border-blue-500 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20'
              }
            `}
          >
            {loading ? 'Scanning...' : 'Rescan'}
          </button>
        </div>

        {report && !loading && (
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Scanned {report.totals.storedObjects.toLocaleString()} stored {report.driver === 's3' ? 'objects' : 'files'}{' '}
            against {report.totals.databaseRows.toLocaleString()} records
            {report.totals.skippedTooRecent > 0 && (
              <> &middot; {report.totals.skippedTooRecent.toLocaleString()} held back as too recent</>
            )}{' '}
            &middot; {formatDate(report.scannedAt)}
          </p>
        )}

        {/* Tabs */}
        <div className="flex gap-2 border-b border-gray-200 dark:border-gray-700">
          {(
            [
              {
                id: 'storage' as const,
                icon: HardDrive,
                label: 'In storage, no record',
                count: report?.storageOrphans.count ?? 0,
              },
              {
                id: 'database' as const,
                icon: Database,
                label: 'Record, no file',
                count: report?.databaseOrphans.count ?? 0,
              },
            ] satisfies Array<{
              id: TabId;
              icon: React.ComponentType<{ className?: string }>;
              label: string;
              count: number;
            }>
          ).map(tab => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => {
                  setActiveTab(tab.id);
                  setConfirming(false);
                }}
                className={`
                  flex items-center gap-2 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors duration-150
                  ${
                    isActive
                      ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                      : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                  }
                `}
              >
                <Icon className="w-4 h-4" />
                <span>{tab.label}</span>
                <span
                  className={`
                    px-1.5 py-0.5 rounded-full text-xs
                    ${
                      tab.count > 0
                        ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-800 dark:text-amber-300'
                        : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400'
                    }
                  `}
                >
                  {tab.count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Explanation of the active category */}
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {activeTab === 'storage'
            ? 'Orphaned Data: Unlinked files taking up storage capacity. Deleting these permanently frees space and cannot be undone.'
            : 'Broken Records: Database entries pointing to missing data. Deleting these safely clears the invalid entry without affecting storage.'}
        </p>

        {/* Selection bar */}
        {currentItemCount > 0 && (
          <div className="flex items-center justify-between">
            <button
              onClick={toggleSelectAll}
              className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
              disabled={deleting}
            >
              {allCurrentSelected ? 'Clear selection' : `Select all ${currentItemCount} shown`}
            </button>
            {selectedCount > 0 && (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {selectedCount} selected &middot; {formatFileSize(selectedBytes)}
              </span>
            )}
          </div>
        )}

        {/* List */}
        {loading ? (
          <p className="py-10 text-center text-gray-600 dark:text-gray-300 flex items-center justify-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            Scanning storage and database...
          </p>
        ) : error ? (
          <p className="py-10 text-center text-red-600 dark:text-red-400">{error}</p>
        ) : currentItemCount === 0 ? (
          <p className="py-10 text-center text-gray-600 dark:text-gray-300">
            {activeTab === 'storage' ? 'No unreferenced data in storage' : 'No records with missing data'}
          </p>
        ) : (
          <div className="space-y-2 overflow-y-auto max-h-[38vh] pr-1">
            {activeTab === 'storage'
              ? storageItems.map(item => (
                  <React.Fragment key={item.key}>
                    {renderRow(
                      selectedKeys.has(item.key),
                      () => toggleKey(item.key),
                      item.key,
                      <p>Last written {formatDate(item.lastModified)}</p>,
                      formatFileSize(item.size)
                    )}
                  </React.Fragment>
                ))
              : databaseItems.map(item => (
                  <React.Fragment key={item.id}>
                    {renderRow(
                      selectedIds.has(item.id),
                      () => toggleId(item.id),
                      item.name,
                      <>
                        <p>Missing key: {item.path}</p>
                        <p>
                          Owner: {item.ownerName || item.ownerEmail || 'Unknown'} &middot; Added{' '}
                          {formatDate(item.createdAt)}
                        </p>
                      </>,
                      formatFileSize(item.size),
                      item.trashed ? (
                        <span className="px-2 py-0.5 text-[11px] rounded-full bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
                          In trash
                        </span>
                      ) : undefined
                    )}
                  </React.Fragment>
                ))}
          </div>
        )}

        {/* Truncation notice */}
        {((activeTab === 'storage' && report?.storageOrphans.truncated) ||
          (activeTab === 'database' && report?.databaseOrphans.truncated)) && (
          <p className="text-xs text-amber-700 dark:text-amber-400">
            Showing the first {currentItemCount.toLocaleString()} entries. Delete these and rescan to see the rest.
          </p>
        )}

        {/* Skipped-entry feedback from the last delete */}
        {skippedNotes.length > 0 && (
          <div className="p-3 rounded-xl bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
            <div className="flex items-center gap-2 mb-1.5">
              <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400" />
              <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                {skippedNotes.length} {skippedNotes.length === 1 ? 'entry was' : 'entries were'} kept
              </p>
            </div>
            <ul className="text-xs text-amber-800 dark:text-amber-300 space-y-0.5 max-h-32 overflow-y-auto">
              {skippedNotes.map(note => (
                <li key={note} className="break-all">
                  {note}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Delete action */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pt-2 border-t border-gray-200 dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {confirming
              ? 'This cannot be undone. Click again to confirm.'
              : selectedCount === 0
                ? 'Select the entries you want to remove'
                : `${selectedCount} selected across both tabs`}
          </p>
          <button
            onClick={handleDelete}
            disabled={selectedCount === 0 || deleting || loading}
            className={`
              inline-flex items-center justify-center gap-2 px-4 py-2 text-sm rounded-xl border transition-colors duration-200
              ${
                selectedCount === 0 || deleting || loading
                  ? 'border-transparent bg-gray-200 dark:bg-gray-700 text-gray-400 cursor-not-allowed'
                  : confirming
                    ? 'border-red-600 bg-red-600 text-white hover:bg-red-700'
                    : 'border-red-500/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30'
              }
            `}
          >
            {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            <span>
              {deleting
                ? 'Deleting...'
                : confirming
                  ? `Confirm delete ${selectedCount}`
                  : `Delete ${selectedCount > 0 ? selectedCount : ''} selected`.replace('  ', ' ')}
            </span>
          </button>
        </div>
      </div>
    </Modal>
  );
};
