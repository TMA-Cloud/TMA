import { useCallback, useEffect, useRef, useState } from 'react';
import type { UploadModalInitialEntry } from '../../../contexts/AppContext';
import { entriesFromDataTransfer } from '../../../utils/folderUpload';
import { throttleTrailing } from '../../../utils/scheduling';

type ToastType = 'success' | 'error' | 'info';

interface ExternalFileDropParams {
  draggingIds: string[];
  isMyFilesView: boolean;
  canUpload: boolean;
  managerRef: React.RefObject<HTMLDivElement | null>;
  uploadModalProcessing: boolean;
  uploadModalProcessingRequestId: string | null;
  setUploadModalOpen: (open: boolean) => void;
  setUploadModalProcessing: (processing: boolean) => void;
  setUploadModalProcessingRequestId: (id: string | null) => void;
  setUploadScanCount: (count: number) => void;
  clearUploadModalInitialEntries: () => void;
  openUploadModalWithEntries: (entries: UploadModalInitialEntry[]) => void;
  showToast: (message: string, type?: ToastType) => void;
}

/** OS drag-in: highlight the drop zone and, on drop in My Files, scan entries into the upload modal. */
export function useExternalFileDrop({
  draggingIds,
  isMyFilesView,
  canUpload,
  managerRef,
  uploadModalProcessing,
  uploadModalProcessingRequestId,
  setUploadModalOpen,
  setUploadModalProcessing,
  setUploadModalProcessingRequestId,
  setUploadScanCount,
  clearUploadModalInitialEntries,
  openUploadModalWithEntries,
  showToast,
}: ExternalFileDropParams) {
  const [isExternalDragOver, setIsExternalDragOver] = useState(false);

  const activeUploadProcessingRequestIdRef = useRef<string | null>(uploadModalProcessingRequestId);
  const uploadModalProcessingRef = useRef(uploadModalProcessing);
  useEffect(() => {
    activeUploadProcessingRequestIdRef.current = uploadModalProcessingRequestId;
  }, [uploadModalProcessingRequestId]);
  useEffect(() => {
    uploadModalProcessingRef.current = uploadModalProcessing;
  }, [uploadModalProcessing]);

  const handleExternalDragOver = useCallback(
    (e: React.DragEvent) => {
      if (draggingIds.length > 0) return;
      if (!isMyFilesView) return;
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setIsExternalDragOver(true);
    },
    [draggingIds.length, isMyFilesView]
  );

  const handleExternalDragLeave = useCallback(
    (e: React.DragEvent) => {
      const related = e.relatedTarget as Node | null;
      if (!related || !managerRef.current?.contains(related)) {
        setIsExternalDragOver(false);
      }
    },
    [managerRef]
  );

  const handleExternalDrop = useCallback(
    async (e: React.DragEvent) => {
      if (draggingIds.length > 0) return;
      if (!canUpload) return;
      if (!e.dataTransfer.files?.length) return;
      if (uploadModalProcessingRef.current) return; // Prevent duplicate drops while we are still scanning folders.
      e.preventDefault();
      e.stopPropagation();
      setIsExternalDragOver(false);
      if (!isMyFilesView) return;
      const requestId = `${Date.now()}-${Math.random()}`;
      try {
        // Open the modal immediately so users get feedback for large folder scans.
        setUploadModalOpen(true);
        setUploadModalProcessing(true);
        setUploadModalProcessingRequestId(requestId);
        clearUploadModalInitialEntries();

        const reportScanned = throttleTrailing((scanned: number) => {
          if (activeUploadProcessingRequestIdRef.current === requestId) setUploadScanCount(scanned);
        }, 100);
        const entries = await entriesFromDataTransfer(e.dataTransfer, { onProgress: reportScanned });
        // User might have closed the modal while we were scanning.
        if (activeUploadProcessingRequestIdRef.current !== requestId) return;

        if (entries.length > 0) {
          openUploadModalWithEntries(entries.map(en => ({ file: en.file, relativePath: en.relativePath })));
          // We keep the modal in "processing" state until the modal consumes the initial entries.
        } else {
          setUploadModalProcessing(false);
          setUploadModalOpen(false);
          showToast('Nothing to upload in that drop', 'info');
        }
      } catch {
        if (activeUploadProcessingRequestIdRef.current !== requestId) return;
        // entriesFromDataTransfer can throw; reset state and close modal (matches previous behavior).
        setUploadModalProcessing(false);
        setUploadModalOpen(false);
        showToast('Failed to read that folder', 'error');
      }
    },
    [
      draggingIds.length,
      isMyFilesView,
      canUpload,
      openUploadModalWithEntries,
      setUploadModalOpen,
      setUploadModalProcessing,
      setUploadModalProcessingRequestId,
      setUploadScanCount,
      clearUploadModalInitialEntries,
      showToast,
    ]
  );

  return { isExternalDragOver, handleExternalDragOver, handleExternalDragLeave, handleExternalDrop };
}
