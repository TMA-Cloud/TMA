/**
 * Upload utility functions
 */

import type React from 'react';

import { checkUploadStorage, type UploadSample } from './api';
import { ApiError } from './errorUtils';

/**
 * How much of a file the server sniffs to decide whether its content matches
 * its extension. Sampling exactly this much means the answer we get before
 * uploading is the answer the upload itself would reach.
 */
const UPLOAD_SAMPLE_BYTES = 8192;

/** Files per pre-check request, so a batch of base64 samples stays inside the JSON body limit. */
const UPLOAD_SAMPLE_BATCH = 32;

/** Kept well under the argument-count limit a spread call has to fit into. */
const CHAR_CODE_CHUNK = 0x8000;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHAR_CODE_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHAR_CODE_CHUNK));
  }
  return btoa(binary);
}

async function readSample(file: File): Promise<UploadSample> {
  const head = await file.slice(0, UPLOAD_SAMPLE_BYTES).arrayBuffer();
  return { name: file.name, head: toBase64(new Uint8Array(head)) };
}

export interface RefusedUpload {
  fileName: string;
  reason: string;
}

function refusalsFrom(error: unknown): RefusedUpload[] | null {
  if (!(error instanceof ApiError) || error.status !== 415) return null;
  const refused = error.data?.refused;
  return Array.isArray(refused) ? (refused as RefusedUpload[]) : [];
}

/**
 * Pre-validates uploads by sending 8KiB file headers upfront to verify storage
 * quota (throws if exceeded) and magic bytes without wasting bandwidth on full transfers.
 *
 * @returns Files whose content contradicts their extension.
 */
export async function precheckUploads(files: File[], totalSize: number): Promise<RefusedUpload[]> {
  const samples = await Promise.all(files.map(readSample));
  const refused: RefusedUpload[] = [];

  for (let i = 0; i < samples.length; i += UPLOAD_SAMPLE_BATCH) {
    const batch = samples.slice(i, i + UPLOAD_SAMPLE_BATCH);
    try {
      // Only the first batch carries the total: the storage limit is a property
      // of the whole upload, not of whichever slice happens to be in flight.
      await checkUploadStorage(i === 0 ? totalSize : 0, batch);
    } catch (error) {
      const batchRefusals = refusalsFrom(error);
      if (!batchRefusals) throw error;
      refused.push(...batchRefusals);
    }
  }

  return refused;
}

export type UploadProgressItem = {
  id: string;
  fileName: string;
  fileSize: number;
  progress: number;
  status: 'uploading' | 'finalizing' | 'completed' | 'error';
  groupId?: string;
};

/**
 * Remove upload progress item by ID
 */
export function removeUploadProgress(prev: UploadProgressItem[], uploadId: string): UploadProgressItem[] {
  return prev.filter(item => item.id !== uploadId);
}

/**
 * Update upload progress item
 */
export function updateUploadProgress(
  prev: UploadProgressItem[],
  uploadId: string,
  updates: Partial<Pick<UploadProgressItem, 'progress' | 'status'>>
): UploadProgressItem[] {
  return prev.map(item => (item.id === uploadId ? { ...item, ...updates } : item));
}

/**
 * Create auto-dismiss timeout handler for upload progress
 * @param uploadId - Upload ID
 * @param isInteractingRef - Ref to check if user is interacting
 * @param setUploadProgress - State setter for upload progress
 * @param uploadDismissTimeoutsRef - Ref to store timeouts
 * @param delay - Delay in milliseconds (default: 10000)
 * @param retryDelay - Retry delay if user is interacting (default: 5000)
 * @returns Timeout ID
 */
export function createAutoDismissTimeout(
  uploadId: string,
  isInteractingRef: { current: boolean },
  setUploadProgress: React.Dispatch<React.SetStateAction<UploadProgressItem[]>>,
  uploadDismissTimeoutsRef: {
    current: Map<string, ReturnType<typeof setTimeout>>;
  },
  delay: number = 10000,
  retryDelay: number = 5000
): ReturnType<typeof setTimeout> {
  const schedule = (ms: number): ReturnType<typeof setTimeout> => {
    const timeout = setTimeout(() => {
      if (!isInteractingRef.current) {
        setUploadProgress(prev => removeUploadProgress(prev, uploadId));
        uploadDismissTimeoutsRef.current.delete(uploadId);
      } else {
        uploadDismissTimeoutsRef.current.set(uploadId, schedule(retryDelay));
      }
    }, ms);
    return timeout;
  };

  return schedule(delay);
}
