/**
 * Shared transfer-progress model for uploads and downloads.
 *
 * Uploads keep their own {@link ./uploadUtils.UploadProgressItem} for historical
 * reasons; this module is the direction-neutral shape the shared UI
 * (`components/transfer/TransferItemCard`) renders, plus the small list helpers
 * the download hook needs. Keeping these generic means one card renders both.
 */
import type React from 'react';

export type TransferStatus = 'uploading' | 'downloading' | 'finalizing' | 'zipping' | 'completed' | 'error';

export interface TransferItem {
  id: string;
  fileName: string;
  /** Total bytes when known, else 0 (indeterminate). */
  fileSize: number;
  /** 0–100. Meaningful only when {@link indeterminate} is false. */
  progress: number;
  status: TransferStatus;
  /** No total size available (e.g. a streamed ZIP): animate the bar instead of tracking a value. */
  indeterminate?: boolean;
  groupId?: string;
}

/** Remove one item by id. */
export function removeTransfer<T extends { id: string }>(prev: T[], id: string): T[] {
  return prev.filter(item => item.id !== id);
}

/** Merge a partial update into one item by id. */
export function updateTransfer<T extends { id: string }>(prev: T[], id: string, updates: Partial<T>): T[] {
  return prev.map(item => (item.id === id ? { ...item, ...updates } : item));
}

/**
 * Auto-dismiss a finished item, deferring while the user is interacting with the
 * stack (mirrors the upload behaviour so both toasts feel identical).
 */
export function createTransferAutoDismiss<T extends { id: string }>(
  id: string,
  isInteractingRef: { current: boolean },
  setItems: React.Dispatch<React.SetStateAction<T[]>>,
  timeoutsRef: { current: Map<string, ReturnType<typeof setTimeout>> },
  delay: number = 10000,
  retryDelay: number = 5000
): ReturnType<typeof setTimeout> {
  const schedule = (ms: number): ReturnType<typeof setTimeout> => {
    return setTimeout(() => {
      if (!isInteractingRef.current) {
        setItems(prev => removeTransfer(prev, id));
        timeoutsRef.current.delete(id);
      } else {
        timeoutsRef.current.set(id, schedule(retryDelay));
      }
    }, ms);
  };
  return schedule(delay);
}
