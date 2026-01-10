/**
 * Upload utility functions
 */

export type UploadProgressItem = {
  id: string;
  fileName: string;
  fileSize: number;
  progress: number;
  status: string;
};

/**
 * Remove upload progress item by ID
 */
export function removeUploadProgress(
  prev: UploadProgressItem[],
  uploadId: string,
): UploadProgressItem[] {
  return prev.filter((item) => item.id !== uploadId);
}

/**
 * Update upload progress item
 */
export function updateUploadProgress(
  prev: UploadProgressItem[],
  uploadId: string,
  updates: Partial<Pick<UploadProgressItem, "progress" | "status">>,
): UploadProgressItem[] {
  return prev.map((item) =>
    item.id === uploadId ? { ...item, ...updates } : item,
  );
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
  isInteractingRef: React.MutableRefObject<boolean>,
  setUploadProgress: React.Dispatch<React.SetStateAction<UploadProgressItem[]>>,
  uploadDismissTimeoutsRef: React.MutableRefObject<Map<string, NodeJS.Timeout>>,
  delay: number = 10000,
  retryDelay: number = 5000,
): NodeJS.Timeout {
  return setTimeout(() => {
    if (!isInteractingRef.current) {
      setUploadProgress((prev) => removeUploadProgress(prev, uploadId));
      uploadDismissTimeoutsRef.current.delete(uploadId);
    } else {
      // If user is interacting, retry after retryDelay
      const retryTimeout = setTimeout(() => {
        if (!isInteractingRef.current) {
          setUploadProgress((prev) => removeUploadProgress(prev, uploadId));
        }
        uploadDismissTimeoutsRef.current.delete(uploadId);
      }, retryDelay);
      uploadDismissTimeoutsRef.current.set(uploadId, retryTimeout);
    }
  }, delay);
}
