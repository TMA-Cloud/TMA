import React, { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import { Upload, X, File, CheckCircle, AlertCircle, RefreshCw, FilePlus } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { useApp } from '../../contexts/AppContext';
import { formatFileSize } from '../../utils/fileUtils';
import { useIsMobile } from '../../hooks/useIsMobile';
import { entriesFromDataTransfer, entriesFromFileList } from '../../utils/folderUpload';

/** Returns a unique name like "name (1).ext" not in existingNames or usedInBatch. */
function getUniqueUploadName(originalName: string, existingNames: Set<string>, usedInBatch: Set<string>): string {
  const lastDot = originalName.lastIndexOf('.');
  const base = lastDot > 0 ? originalName.slice(0, lastDot) : originalName;
  const ext = lastDot > 0 ? originalName.slice(lastDot) : '';
  let n = 1;
  let candidate: string;
  do {
    candidate = `${base} (${n})${ext}`;
    n += 1;
  } while (existingNames.has(candidate) || usedInBatch.has(candidate));
  return candidate;
}

interface UploadFile {
  id: string;
  file: File;
  relativePath?: string;
  progress: number;
  status: 'pending' | 'uploading' | 'completed' | 'error';
}

export const UploadModal: React.FC = () => {
  const {
    uploadModalOpen,
    setUploadModalOpen,
    uploadModalInitialEntries,
    clearUploadModalInitialEntries,
    files: contextFiles,
    uploadFileWithProgress,
    replaceFileWithProgress,
    uploadEntriesBulk,
    uploadProgress,
  } = useApp();
  const [uploadFiles, setUploadFiles] = useState<UploadFile[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [duplicateModalOpen, setDuplicateModalOpen] = useState(false);
  /** Conflicting upload items (id) and the existing file name. Resolutions stored in duplicateChoices. */
  const [duplicateConflicts, setDuplicateConflicts] = useState<{ uploadId: string; fileName: string }[]>([]);
  /** User choice per conflicting upload id: 'replace' | 'rename' */
  const [duplicateChoices, setDuplicateChoices] = useState<Record<string, 'replace' | 'rename'>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();

  const existingFileNames = useMemo(
    () => new Set(contextFiles.filter(f => f.type === 'file').map(f => f.name)),
    [contextFiles]
  );
  const existingFileByName = useMemo(
    () => new Map(contextFiles.filter(f => f.type === 'file').map(f => [f.name, f])),
    [contextFiles]
  );

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

  // When modal is opened with initial entries (e.g. from drag onto file manager), consume them
  useEffect(() => {
    if (!uploadModalOpen || !uploadModalInitialEntries?.length) return;
    const entries = uploadModalInitialEntries;
    clearUploadModalInitialEntries();
    handleEntries(entries);
  }, [uploadModalOpen, uploadModalInitialEntries, clearUploadModalInitialEntries, handleEntries]);

  const handleFiles = (files: FileList) => {
    handleEntries(Array.from(files).map(file => ({ file })));
  };

  const handleFolderFiles = (files: FileList) => {
    const entries = entriesFromFileList(files);
    handleEntries(entries.map(e => ({ file: e.file, relativePath: e.relativePath })));
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    void (async () => {
      const entries = await entriesFromDataTransfer(e.dataTransfer);
      if (entries.length > 0) {
        handleEntries(entries.map(en => ({ file: en.file, relativePath: en.relativePath })));
      }
    })();
  };

  const handleDropZoneClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest('[data-upload-action="true"]')) return;
    if (target?.closest('input')) return;
    fileInputRef.current?.click();
  };

  const handleDragOver = (e: React.DragEvent) => {
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

  const handleClose = () => {
    setUploadFiles([]);
    setDuplicateConflicts([]);
    setDuplicateChoices({});
    setUploadModalOpen(false);
    setDuplicateModalOpen(false);
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

  /** Build replace list and new-files list from current pending items and resolutions. */
  const buildUploadPlan = (resolutions: Record<string, 'replace' | 'rename'>) => {
    const replaceItems: { fileId: string; file: File }[] = [];
    const usedInBatch = new Set(existingFileNames);
    const newFiles: { file: File; relativePath?: string; clientId: string }[] = [];

    for (const item of pendingItems) {
      const clientId = item.id;
      if (item.relativePath) {
        newFiles.push({ file: item.file, relativePath: item.relativePath, clientId });
        continue;
      }

      const choice = resolutions[item.id];
      if (!choice) {
        newFiles.push({ file: item.file, clientId });
        continue;
      }
      if (choice === 'replace') {
        const existing = existingFileByName.get(item.file.name);
        if (existing?.id) {
          replaceItems.push({ fileId: existing.id, file: item.file });
        } else {
          newFiles.push({ file: item.file, clientId });
        }
        continue;
      }
      if (choice === 'rename') {
        const newName = getUniqueUploadName(item.file.name, existingFileNames, usedInBatch);
        usedInBatch.add(newName);
        const type = item.file.type || 'application/octet-stream';
        const renamedFile = new (
          window as Window & { File: new (b: BlobPart[], n: string, o?: FilePropertyBag) => File }
        ).File([item.file], newName, { type, lastModified: Date.now() });
        newFiles.push({ file: renamedFile, clientId });
      }
    }
    return { replaceItems, newFiles };
  };

  /** Execute a pre-built upload plan (used after Confirm to avoid closure issues). */
  const executeUploadPlan = async (plan: {
    replaceItems: { fileId: string; file: File }[];
    newFiles: { file: File; relativePath?: string; clientId: string }[];
  }) => {
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
      setUploadFiles(prev => prev.filter(f => f.status === 'pending' || f.status === 'error'));
    } finally {
      setIsUploading(false);
    }
  };

  /** Run the actual upload after duplicate resolution (or when no conflicts). */
  const doActualUpload = async (resolutions: Record<string, 'replace' | 'rename'>) => {
    const plan = buildUploadPlan(resolutions);
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

    void doActualUpload({});
  };

  const confirmDuplicateAndUpload = () => {
    const allChosen = duplicateConflicts.every(c => duplicateChoices[c.uploadId] != null);
    if (!allChosen) return;
    const plan = buildUploadPlan(duplicateChoices);
    setUploadModalOpen(false);
    setDuplicateModalOpen(false);
    setDuplicateConflicts([]);
    setDuplicateChoices({});
    setIsUploading(true);
    void executeUploadPlan(plan);
  };

  /** Preview name for "Upload with Renamed" – use same order as doActualUpload (pendingItems). */
  const renamedPreview = (uploadId: string): string => {
    if (duplicateChoices[uploadId] !== 'rename') return '';
    const usedInBatch = new Set(existingFileNames);
    for (const item of pendingItems) {
      if (duplicateChoices[item.id] !== 'rename') continue;
      const name = getUniqueUploadName(item.file.name, existingFileNames, usedInBatch);
      usedInBatch.add(name);
      if (item.id === uploadId) return name;
    }
    return '';
  };

  const allDuplicateChoicesMade =
    duplicateConflicts.length > 0 && duplicateConflicts.every(c => duplicateChoices[c.uploadId] != null);

  return (
    <Modal isOpen={uploadModalOpen} onClose={handleClose} title="Upload" size={isMobile ? 'full' : 'xl'}>
      <div className={isMobile ? 'space-y-4' : 'space-y-6'}>
        {/* Drop Zone - full prompt when empty, compact "add more" when files already in list */}
        <div
          className={`
            relative border-2 border-dashed rounded-lg text-center transition-colors duration-200
            ${uploadFiles.length > 0 ? 'py-3 px-4 min-h-0 flex items-center justify-center' : isMobile ? 'p-6 min-h-[180px] flex items-center justify-center' : 'p-10 min-h-[320px] flex items-center justify-center'}
            ${
              isDragOver
                ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                : 'border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500'
            }
          `}
          onClick={handleDropZoneClick}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          <input ref={fileInputRef} type="file" multiple onChange={handleFileInput} className="hidden" />
          <input
            ref={folderInputRef}
            type="file"
            multiple
            webkitdirectory=""
            directory=""
            onChange={handleFolderInput}
            className="hidden"
          />

          {uploadFiles.length > 0 ? (
            <div className="flex flex-wrap items-center justify-center gap-2 w-full">
              <span className="text-sm text-gray-500 dark:text-gray-400">Add more:</span>
              <button
                data-upload-action="true"
                type="button"
                onClick={e => {
                  e.stopPropagation();
                  folderInputRef.current?.click();
                }}
                className="px-3 py-1.5 text-sm font-medium text-blue-700 dark:text-blue-200 bg-blue-50 dark:bg-blue-900/40 border border-blue-400 dark:border-blue-500 hover:bg-blue-100 dark:hover:bg-blue-900/60 rounded-lg transition-colors"
              >
                Folder
              </button>
              <button
                data-upload-action="true"
                type="button"
                onClick={e => {
                  e.stopPropagation();
                  fileInputRef.current?.click();
                }}
                className="px-3 py-1.5 text-sm font-medium text-blue-700 dark:text-blue-200 bg-blue-50 dark:bg-blue-900/40 border border-blue-400 dark:border-blue-500 hover:bg-blue-100 dark:hover:bg-blue-900/60 rounded-lg transition-colors"
              >
                Files
              </button>
              <span className="text-sm text-gray-400 dark:text-gray-500">or drop here</span>
            </div>
          ) : (
            <div className={`${isMobile ? 'space-y-3' : 'space-y-4'} w-full`}>
              <div
                className={`mx-auto ${
                  isMobile ? 'w-12 h-12' : 'w-16 h-16'
                } bg-gray-100 dark:bg-gray-700 rounded-full flex items-center justify-center`}
              >
                <Upload className={`${isMobile ? 'w-6 h-6' : 'w-8 h-8'} text-gray-400`} />
              </div>

              <div>
                <p className={`${isMobile ? 'text-base' : 'text-lg'} font-medium text-gray-900 dark:text-gray-100`}>
                  {isMobile ? 'Tap to select files or a folder' : 'Drag and drop files or folders here'}
                </p>
                <p className={`${isMobile ? 'text-xs' : 'text-sm'} text-gray-500 dark:text-gray-400 mt-1`}>
                  {isMobile ? 'or browse from your device' : 'or click to browse from your computer'}
                </p>
              </div>

              <div className="flex items-center justify-center gap-3">
                <button
                  data-upload-action="true"
                  type="button"
                  onClick={e => {
                    e.stopPropagation();
                    folderInputRef.current?.click();
                  }}
                  className="px-5 py-3 text-sm font-semibold text-blue-700 dark:text-blue-200 bg-blue-50 dark:bg-blue-900/40 border-2 border-blue-400 dark:border-blue-500 hover:bg-blue-100 dark:hover:bg-blue-900/60 hover:border-blue-500 dark:hover:border-blue-400 rounded-lg transition-colors shadow-sm"
                >
                  Upload folder
                </button>
                <button
                  data-upload-action="true"
                  type="button"
                  onClick={e => {
                    e.stopPropagation();
                    fileInputRef.current?.click();
                  }}
                  className="px-5 py-3 text-sm font-semibold text-blue-700 dark:text-blue-200 bg-blue-50 dark:bg-blue-900/40 border-2 border-blue-400 dark:border-blue-500 hover:bg-blue-100 dark:hover:bg-blue-900/60 hover:border-blue-500 dark:hover:border-blue-400 rounded-lg transition-colors shadow-sm"
                >
                  Upload files
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Active Uploads from Global State */}
        {uploadProgress.filter(u => u.status === 'uploading').length > 0 && (
          <div className={isMobile ? 'space-y-2' : 'space-y-3'}>
            <h4 className={`${isMobile ? 'text-sm' : 'text-base'} font-semibold text-gray-900 dark:text-gray-100`}>
              Uploading ({uploadProgress.filter(u => u.status === 'uploading').length})
            </h4>
            <div className={`space-y-2 ${isMobile ? 'max-h-32' : 'max-h-48'} overflow-y-auto`}>
              {uploadProgress
                .filter(u => u.status === 'uploading')
                .map(upload => (
                  <div
                    key={upload.id}
                    className={`flex items-center ${
                      isMobile ? 'space-x-2 p-2' : 'space-x-3 p-3'
                    } bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800`}
                  >
                    <div className="flex-shrink-0">
                      <div
                        className={`${
                          isMobile ? 'w-7 h-7' : 'w-8 h-8'
                        } rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center`}
                      >
                        <Upload
                          className={`${
                            isMobile ? 'w-3.5 h-3.5' : 'w-4 h-4'
                          } text-blue-600 dark:text-blue-400 animate-pulse`}
                        />
                      </div>
                    </div>

                    <div className="flex-1 min-w-0">
                      <p
                        className={`${
                          isMobile ? 'text-xs' : 'text-sm'
                        } font-medium text-gray-900 dark:text-gray-100 truncate`}
                      >
                        {upload.fileName}
                      </p>
                      <div className="flex items-center justify-between mt-0.5">
                        <p className={`${isMobile ? 'text-[10px]' : 'text-xs'} text-gray-500 dark:text-gray-400`}>
                          {formatFileSize(upload.fileSize)}
                        </p>
                        <p
                          className={`${
                            isMobile ? 'text-[10px]' : 'text-xs'
                          } font-semibold text-blue-600 dark:text-blue-400`}
                        >
                          {upload.progress}%
                        </p>
                      </div>
                      <div className={isMobile ? 'mt-1.5' : 'mt-2'}>
                        <div
                          className={`bg-gray-200 dark:bg-gray-700 rounded-full ${
                            isMobile ? 'h-1' : 'h-1.5'
                          } overflow-hidden`}
                        >
                          <div
                            className={`bg-gradient-to-r from-blue-500 to-blue-600 ${
                              isMobile ? 'h-1' : 'h-1.5'
                            } rounded-full transition-all duration-500 ease-out`}
                            style={{ width: `${upload.progress}%` }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* Pending Files List */}
        {uploadFiles.length > 0 && (
          <div className={isMobile ? 'space-y-2' : 'space-y-3'}>
            <h4 className={`${isMobile ? 'text-sm' : 'text-base'} font-semibold text-gray-900 dark:text-gray-100`}>
              Files to Upload ({uploadFiles.length})
            </h4>
            <div className={`space-y-2 ${isMobile ? 'max-h-32' : 'max-h-48'} overflow-y-auto`}>
              {uploadFiles.map(uploadFile => (
                <div
                  key={uploadFile.id}
                  className={`flex items-center ${
                    isMobile ? 'space-x-2 p-2' : 'space-x-3 p-3'
                  } bg-gray-50 dark:bg-gray-700 rounded-lg`}
                >
                  <div className="flex-shrink-0">
                    {uploadFile.status === 'completed' ? (
                      <CheckCircle className={`${isMobile ? 'w-5 h-5' : 'w-6 h-6'} text-green-500`} />
                    ) : uploadFile.status === 'error' ? (
                      <AlertCircle className={`${isMobile ? 'w-5 h-5' : 'w-6 h-6'} text-red-500`} />
                    ) : (
                      <File className={`${isMobile ? 'w-5 h-5' : 'w-6 h-6'} text-gray-400`} />
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <p
                      className={`${
                        isMobile ? 'text-xs' : 'text-sm'
                      } font-medium text-gray-900 dark:text-gray-100 truncate`}
                    >
                      {uploadFile.relativePath || uploadFile.file.name}
                    </p>
                    <p className={`${isMobile ? 'text-[10px]' : 'text-xs'} text-gray-500 dark:text-gray-400`}>
                      {formatFileSize(uploadFile.file.size)}
                    </p>

                    {uploadFile.status === 'uploading' && (
                      <div className={isMobile ? 'mt-1' : 'mt-1'}>
                        <div className={`bg-gray-200 dark:bg-gray-600 rounded-full ${isMobile ? 'h-1' : 'h-1'}`}>
                          <div
                            className={`bg-blue-500 ${
                              isMobile ? 'h-1' : 'h-1'
                            } rounded-full transition-all duration-300`}
                            style={{ width: `${uploadFile.progress}%` }}
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  <button
                    onClick={() => removeFile(uploadFile.id)}
                    className={`flex-shrink-0 ${
                      isMobile ? 'p-1.5' : ''
                    } text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors active:scale-95`}
                    aria-label="Remove file"
                  >
                    <X className={`${isMobile ? 'w-4 h-4' : 'w-4 h-4'}`} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className={`flex ${isMobile ? 'flex-col-reverse space-y-reverse space-y-2' : 'justify-end space-x-3'}`}>
          <button
            onClick={handleClose}
            className={`${
              isMobile ? 'w-full px-4 py-3 text-base' : 'px-4 py-2 text-sm'
            } text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors duration-200 active:scale-95`}
          >
            Close
          </button>
          <button
            onClick={startUpload}
            disabled={isUploading || !uploadFiles.some(f => f.status === 'pending' || f.status === 'error')}
            className={`${
              isMobile ? 'w-full px-4 py-3 text-base font-semibold' : 'px-4 py-2 text-sm'
            } bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed active:scale-95`}
          >
            {isUploading ? 'Uploading...' : 'Upload'}
          </button>
        </div>
      </div>

      {/* Duplicate resolution modal – shown before any upload when same-name files exist */}
      <Modal
        isOpen={duplicateModalOpen}
        onClose={() => setDuplicateModalOpen(false)}
        title="File already exists"
        size={isMobile ? 'full' : 'lg'}
      >
        <div className="space-y-4">
          <p className="text-sm text-gray-600 dark:text-gray-400">
            The following file(s) already exist in this folder. Choose an action for each before uploading.
          </p>
          <ul className={`space-y-4 ${isMobile ? 'max-h-[60vh]' : 'max-h-[50vh]'} overflow-y-auto pr-1`}>
            {duplicateConflicts.map(({ uploadId, fileName }) => {
              const newName = renamedPreview(uploadId);
              return (
                <li
                  key={uploadId}
                  className="flex flex-col gap-3 p-4 rounded-xl bg-gray-50 dark:bg-gray-700/50 border border-gray-200 dark:border-gray-600"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-900 dark:text-gray-100 break-all">{fileName}</p>
                    {duplicateChoices[uploadId] === 'rename' && newName && (
                      <div className="mt-2 py-2 px-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
                        <p className="text-xs font-medium text-blue-700 dark:text-blue-300 uppercase tracking-wide mb-0.5">
                          New name
                        </p>
                        <p className="text-sm font-medium text-gray-900 dark:text-gray-100 break-all">{newName}</p>
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setDuplicateChoices(prev => ({ ...prev, [uploadId]: 'replace' }))}
                      className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                        duplicateChoices[uploadId] === 'replace'
                          ? 'bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-200 border-2 border-amber-400 dark:border-amber-600'
                          : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 border-2 border-transparent'
                      }`}
                    >
                      <RefreshCw className="w-4 h-4 flex-shrink-0" />
                      Replace the File
                    </button>
                    <button
                      type="button"
                      onClick={() => setDuplicateChoices(prev => ({ ...prev, [uploadId]: 'rename' }))}
                      className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                        duplicateChoices[uploadId] === 'rename'
                          ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 border-2 border-blue-400 dark:border-blue-600'
                          : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 border-2 border-transparent'
                      }`}
                    >
                      <FilePlus className="w-4 h-4 flex-shrink-0" />
                      Upload with Renamed
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setDuplicateModalOpen(false)}
              className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirmDuplicateAndUpload}
              disabled={!allDuplicateChoicesMade}
              className="px-4 py-2 text-sm font-semibold bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Confirm and Upload
            </button>
          </div>
        </div>
      </Modal>
    </Modal>
  );
};
