import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp, type UploadModalInitialEntry } from '../../contexts/AppContext';
import { useToast } from '../../hooks/useToast';
import {
  entriesFromDataTransfer,
  entriesFromFileListAsync,
  isScanAborted,
  plainEntriesFromFileListAsync,
  type FolderUploadEntry,
  type ScanOptions,
} from '../../utils/folderUpload';
import { throttleTrailing } from '../../utils/scheduling';
import {
  buildFolderUploadGroups,
  buildUploadPlan,
  computeRenamedPreview,
  getRootFolderName,
  MAX_VISIBLE_PENDING,
  type UploadFile,
  type UploadPlan,
} from './uploadStaging';

/** Upload-modal staging: stage files, group folders, resolve name conflicts, run the upload plan. */
export function useUploadStaging() {
  const {
    uploadModalOpen,
    setUploadModalOpen,
    uploadModalProcessing,
    setUploadModalProcessing,
    setUploadModalProcessingRequestId,
    uploadScanCount,
    setUploadScanCount,
    uploadModalInitialEntries,
    clearUploadModalInitialEntries,
    files: contextFiles,
    uploadFileWithProgress,
    replaceFileWithProgress,
    uploadEntriesBulk,
    uploadProgress,
    cancelUpload,
    cancelUploadGroup,
  } = useApp();
  const { showToast } = useToast();

  const [uploadFiles, setUploadFiles] = useState<UploadFile[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [hasStartedUpload, setHasStartedUpload] = useState(false);
  const [duplicateModalOpen, setDuplicateModalOpen] = useState(false);
  /** Conflicting upload items (id) and the existing file name. Resolutions stored in duplicateChoices. */
  const [duplicateConflicts, setDuplicateConflicts] = useState<{ uploadId: string; fileName: string }[]>([]);
  /** User choice per conflicting upload id: 'replace' | 'rename' */
  const [duplicateChoices, setDuplicateChoices] = useState<Record<string, 'replace' | 'rename'>>({});

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  /** Lets a closed modal or a second selection abandon a scan already running. */
  const scanAbortRef = useRef<AbortController | null>(null);
  /** The dropped batch already staged, so a repeated effect run cannot stage it again. */
  const consumedInitialEntriesRef = useRef<UploadModalInitialEntry[] | null>(null);

  const existingFileNames = useMemo(
    () => new Set(contextFiles.filter(f => f.type === 'file').map(f => f.name)),
    [contextFiles]
  );
  const existingFileByName = useMemo(
    () => new Map(contextFiles.filter(f => f.type === 'file').map(f => [f.name, f])),
    [contextFiles]
  );

  const isFolderUploadOnly = useMemo(
    () => uploadFiles.length > 0 && uploadFiles.every(f => !!f.relativePath),
    [uploadFiles]
  );

  const folderUploadGroups = useMemo(
    () => (isFolderUploadOnly ? buildFolderUploadGroups(uploadFiles) : []),
    [isFolderUploadOnly, uploadFiles]
  );

  const visiblePendingFiles = useMemo(() => uploadFiles.slice(0, MAX_VISIBLE_PENDING), [uploadFiles]);
  const hiddenPendingCount = uploadFiles.length - visiblePendingFiles.length;

  const handleEntries = useCallback((entries: { file: File; relativePath?: string }[]) => {
    const now = Date.now();
    const newUploadFiles: UploadFile[] = entries.map((entry, index) => ({
      id: `${now}-${index}`,
      file: entry.file,
      relativePath: entry.relativePath,
      progress: 0,
      status: 'pending' as const,
    }));
    setUploadFiles(prev => [...prev, ...newUploadFiles]);
  }, []);

  // Consume a drop from the file manager exactly once. The ref (not the cleared
  // state, which lands a render later) guards against re-runs and StrictMode.
  useEffect(() => {
    if (!uploadModalOpen || !uploadModalInitialEntries?.length) return;
    if (consumedInitialEntriesRef.current === uploadModalInitialEntries) return;
    consumedInitialEntriesRef.current = uploadModalInitialEntries;

    clearUploadModalInitialEntries();
    handleEntries(uploadModalInitialEntries);
    // Stop the "processing" UI as soon as we've staged the scanned entries
    // (even if they later end up being removed/filtered elsewhere)
    setUploadModalProcessing(false);
    setUploadModalProcessingRequestId(null);
    setUploadScanCount(0);
  }, [
    uploadModalOpen,
    uploadModalInitialEntries,
    clearUploadModalInitialEntries,
    handleEntries,
    setUploadModalProcessing,
    setUploadModalProcessingRequestId,
    setUploadScanCount,
  ]);

  /** Runs a folder scan with the modal in "processing" state and a live count. */
  const runScan = useCallback(
    async (scan: (options: ScanOptions) => Promise<FolderUploadEntry[]>) => {
      scanAbortRef.current?.abort();
      const controller = new AbortController();
      scanAbortRef.current = controller;

      setUploadModalProcessing(true);
      setUploadScanCount(0);
      const reportProgress = throttleTrailing((scanned: number) => {
        if (!controller.signal.aborted) setUploadScanCount(scanned);
      }, 100);

      try {
        const entries = await scan({ signal: controller.signal, onProgress: reportProgress });
        if (controller.signal.aborted) return;
        if (entries.length > 0) {
          handleEntries(entries.map(en => ({ file: en.file, relativePath: en.relativePath })));
        }
      } catch (err) {
        // An abandoned scan is the expected end of a superseded selection.
        if (!isScanAborted(err)) showToast('Failed to read that folder', 'error');
      } finally {
        if (scanAbortRef.current === controller) {
          scanAbortRef.current = null;
          setUploadModalProcessing(false);
          setUploadModalProcessingRequestId(null);
          setUploadScanCount(0);
        }
      }
    },
    [handleEntries, setUploadModalProcessing, setUploadModalProcessingRequestId, setUploadScanCount, showToast]
  );

  const handleFiles = (files: FileList) => {
    void runScan(options => plainEntriesFromFileListAsync(files, options));
  };

  const handleFolderFiles = (files: FileList) => {
    void runScan(options => entriesFromFileListAsync(files, options));
  };

  const handleDrop = (e: React.DragEvent) => {
    if (uploadModalProcessing) return;
    e.preventDefault();
    setIsDragOver(false);
    // The DataTransfer's entries must be read before the event returns, so the
    // scan is started from inside the handler and awaited elsewhere.
    const { dataTransfer } = e;
    void runScan(options => entriesFromDataTransfer(dataTransfer, options));
  };

  const handleDropZoneClick = (e: React.MouseEvent) => {
    if (uploadModalProcessing) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('[data-upload-action="true"]')) return;
    if (target?.closest('input')) return;
    fileInputRef.current?.click();
  };

  const handleDragOver = (e: React.DragEvent) => {
    if (uploadModalProcessing) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    const related = e.relatedTarget as Node | null;
    const current = e.currentTarget as Node;
    if (!related || !current.contains(related)) {
      setIsDragOver(false);
    }
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) {
      handleFiles(files);
    }
    e.target.value = '';
  };

  const handleFolderInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) {
      handleFolderFiles(files);
    }
    e.target.value = '';
  };

  const removeFile = (fileId: string) => {
    setUploadFiles(prev => prev.filter(f => f.id !== fileId));
  };

  const removeFolderGroup = (groupName: string) => {
    setUploadFiles(prev =>
      prev.filter(uploadFile => {
        const root = getRootFolderName(uploadFile.relativePath, uploadFile.file.name);
        return root !== groupName;
      })
    );
  };

  const handleClose = () => {
    scanAbortRef.current?.abort();
    scanAbortRef.current = null;
    consumedInitialEntriesRef.current = null;
    setUploadScanCount(0);
    setUploadFiles([]);
    setDuplicateConflicts([]);
    setDuplicateChoices({});
    setHasStartedUpload(false);
    setUploadModalOpen(false);
    setUploadModalProcessing(false);
    setUploadModalProcessingRequestId(null);
    setDuplicateModalOpen(false);
    clearUploadModalInitialEntries();
  };

  const pendingItems = useMemo(
    () => uploadFiles.filter(f => f.status === 'pending' || f.status === 'error'),
    [uploadFiles]
  );

  const conflicts = useMemo(
    // Only check duplicates for direct uploads into the current folder.
    // Folder uploads can contain the same filename in different subfolders.
    () => pendingItems.filter(item => !item.relativePath && existingFileNames.has(item.file.name)),
    [pendingItems, existingFileNames]
  );

  /** Execute a pre-built upload plan (used after Confirm to avoid closure issues). */
  const executeUploadPlan = async (plan: UploadPlan) => {
    try {
      await Promise.all(
        plan.replaceItems.map(({ fileId, file }) =>
          replaceFileWithProgress(fileId, file).catch(() => {
            // Error handled by upload progress UI
          })
        )
      );
      if (plan.newFiles.length > 0) {
        const entries = plan.newFiles.map(f => ({ file: f.file, relativePath: f.relativePath, clientId: f.clientId }));
        if (entries.length === 1) {
          const [first] = entries;
          if (!first) return;
          if (!first.relativePath) {
            await uploadFileWithProgress(first.file);
          } else {
            await uploadEntriesBulk(entries);
          }
        } else {
          await uploadEntriesBulk(entries);
        }
      }
      setUploadFiles(prev => prev.filter(f => f.status === 'error'));
    } catch {
      // On errors, keep pending/error items so user can retry
      setUploadFiles(prev => prev.filter(f => f.status === 'pending' || f.status === 'error'));
    } finally {
      setIsUploading(false);
    }
  };

  /** Run the actual upload after duplicate resolution (or when no conflicts). */
  const doActualUpload = async (resolutions: Record<string, 'replace' | 'rename'>) => {
    const plan = buildUploadPlan(pendingItems, existingFileNames, existingFileByName, resolutions);
    setIsUploading(true);
    setUploadModalOpen(false);
    setDuplicateModalOpen(false);
    setDuplicateConflicts([]);
    setDuplicateChoices({});
    await executeUploadPlan(plan);
  };

  const startUpload = () => {
    if (pendingItems.length === 0) return;

    if (conflicts.length > 0) {
      setDuplicateConflicts(conflicts.map(c => ({ uploadId: c.id, fileName: c.file.name })));
      setDuplicateChoices(prev => {
        const next = { ...prev };
        conflicts.forEach(c => {
          delete next[c.id];
        });
        return next;
      });
      setDuplicateModalOpen(true);
      return;
    }

    setHasStartedUpload(true);
    void doActualUpload({});
  };

  const confirmDuplicateAndUpload = () => {
    const allChosen = duplicateConflicts.every(c => duplicateChoices[c.uploadId] != null);
    if (!allChosen) return;
    const plan = buildUploadPlan(pendingItems, existingFileNames, existingFileByName, duplicateChoices);
    setHasStartedUpload(true);
    setUploadModalOpen(false);
    setDuplicateModalOpen(false);
    setDuplicateConflicts([]);
    setDuplicateChoices({});
    setIsUploading(true);
    void executeUploadPlan(plan);
  };

  /** Preview name for "Upload with Renamed" – use same order as doActualUpload (pendingItems). */
  const renamedPreview = (uploadId: string): string =>
    computeRenamedPreview(uploadId, pendingItems, duplicateChoices, existingFileNames);

  const allDuplicateChoicesMade =
    duplicateConflicts.length > 0 && duplicateConflicts.every(c => duplicateChoices[c.uploadId] != null);

  // Derive current uploading items and the batch group they belong to. A
  // batched upload reports as one aggregate row, so a single grouped item is
  // still a group — cancelling it stops every batch behind it.
  const uploadingProgressItems = uploadProgress.filter(u => u.status === 'uploading' || u.status === 'finalizing');
  const bulkGroupId = uploadingProgressItems.find(item => item.groupId)?.groupId ?? null;

  const cancelBulkGroup = (groupId: string) => {
    cancelUploadGroup(groupId);
    // Clear all staged files in the modal for this bulk upload.
    setUploadFiles([]);
    setHasStartedUpload(false);
    setDuplicateConflicts([]);
    setDuplicateChoices({});
  };

  const cancelSingleUpload = (uploadId: string) => {
    cancelUpload(uploadId);
    setUploadFiles(prev => prev.filter(f => f.id !== uploadId));
  };

  return {
    // Passthrough context/UI state the modal renders
    uploadModalOpen,
    uploadModalProcessing,
    uploadScanCount,

    // Staging state
    uploadFiles,
    isDragOver,
    isUploading,
    hasStartedUpload,
    isFolderUploadOnly,
    folderUploadGroups,
    visiblePendingFiles,
    hiddenPendingCount,
    uploadingProgressItems,
    bulkGroupId,

    // Duplicate resolution
    duplicateModalOpen,
    setDuplicateModalOpen,
    duplicateConflicts,
    duplicateChoices,
    setDuplicateChoices,
    allDuplicateChoicesMade,
    renamedPreview,
    confirmDuplicateAndUpload,

    // Refs + handlers
    fileInputRef,
    folderInputRef,
    handleClose,
    handleDrop,
    handleDragOver,
    handleDragLeave,
    handleDropZoneClick,
    handleFileInput,
    handleFolderInput,
    removeFile,
    removeFolderGroup,
    startUpload,
    cancelBulkGroup,
    cancelSingleUpload,
  };
}
