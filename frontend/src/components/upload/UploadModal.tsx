import React from 'react';
import { Upload, File, Folder, CheckCircle, AlertCircle, RefreshCw, FilePlus, Loader2 } from 'lucide-react';
import { Modal } from '../ui/Modal';
import { formatFileSize } from '../../utils/fileUtils';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useUploadStaging } from './useUploadStaging';

export const UploadModal: React.FC = () => {
  const isMobile = useIsMobile();
  const {
    uploadModalOpen,
    uploadModalProcessing,
    uploadScanCount,
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
    duplicateModalOpen,
    setDuplicateModalOpen,
    duplicateConflicts,
    duplicateChoices,
    setDuplicateChoices,
    allDuplicateChoicesMade,
    renamedPreview,
    confirmDuplicateAndUpload,
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
  } = useUploadStaging();

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

          {uploadModalProcessing ? (
            <div className={`w-full flex flex-col items-center justify-center text-center space-y-3`}>
              <div
                className={`mx-auto ${
                  isMobile ? 'w-10 h-10' : 'w-12 h-12'
                } bg-gray-100 dark:bg-gray-700 rounded-full flex items-center justify-center`}
              >
                <Loader2 className={`${isMobile ? 'w-5 h-5' : 'w-6 h-6'} text-gray-500 animate-spin`} />
              </div>
              <div className="space-y-1">
                <p className={`${isMobile ? 'text-base' : 'text-lg'} font-semibold text-gray-900 dark:text-gray-100`}>
                  {uploadScanCount > 0 ? `Found ${uploadScanCount.toLocaleString()} files…` : 'Processing to Upload...'}
                </p>
                <p className={`${isMobile ? 'text-xs' : 'text-sm'} text-gray-500 dark:text-gray-400`}>
                  Preparing files from your folder (this can take a moment for large folder trees)
                </p>
              </div>
            </div>
          ) : uploadFiles.length > 0 ? (
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
        {uploadingProgressItems.length > 0 && (
          <div className={isMobile ? 'space-y-2' : 'space-y-3'}>
            <div className="flex items-center justify-between">
              <h4 className={`${isMobile ? 'text-sm' : 'text-base'} font-semibold text-gray-900 dark:text-gray-100`}>
                Uploading ({uploadingProgressItems.length})
              </h4>
              {bulkGroupId && (
                <button
                  type="button"
                  onClick={() => cancelBulkGroup(bulkGroupId)}
                  className={`px-2.5 py-1 rounded-full text-[10px] ${
                    isMobile ? '' : 'text-xs'
                  } font-medium text-red-700 dark:text-red-200 bg-red-50 dark:bg-red-900/30 hover:bg-red-100 dark:hover:bg-red-900/50 border border-red-200 dark:border-red-700 transition-colors duration-150 active:scale-95`}
                >
                  Cancel all
                </button>
              )}
            </div>
            <div className={`space-y-2 ${isMobile ? 'max-h-32' : 'max-h-48'} overflow-y-auto`}>
              {uploadingProgressItems.map(upload => (
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
                      {upload.status === 'finalizing' ? (
                        <Loader2
                          className={`${
                            isMobile ? 'w-3.5 h-3.5' : 'w-4 h-4'
                          } text-blue-600 dark:text-blue-400 animate-spin`}
                        />
                      ) : (
                        <Upload
                          className={`${
                            isMobile ? 'w-3.5 h-3.5' : 'w-4 h-4'
                          } text-blue-600 dark:text-blue-400 animate-pulse`}
                        />
                      )}
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
                        {upload.status === 'finalizing' ? 'Finalizing upload...' : `${upload.progress}%`}
                      </p>
                    </div>
                    <div className={isMobile ? 'mt-1.5' : 'mt-2'}>
                      <div
                        className={`bg-gray-200 dark:bg-gray-700 rounded-full ${
                          isMobile ? 'h-1' : 'h-1.5'
                        } overflow-hidden`}
                      >
                        <div
                          className={`bg-[var(--accent)] ${
                            isMobile ? 'h-1' : 'h-1.5'
                          } rounded-full transition-all duration-500 ease-out`}
                          style={{ width: `${upload.progress}%` }}
                        />
                      </div>
                    </div>
                  </div>

                  {!upload.groupId && (
                    <button
                      type="button"
                      onClick={() => cancelSingleUpload(upload.id)}
                      className={`ml-2 flex-shrink-0 px-2.5 py-1 rounded-full text-[10px] ${
                        isMobile ? '' : 'text-xs'
                      } font-medium text-blue-700 dark:text-blue-200 bg-blue-100/80 dark:bg-blue-900/40 hover:bg-blue-200 dark:hover:bg-blue-800/70 border border-blue-300/80 dark:border-blue-700/80 transition-colors duration-150 active:scale-95`}
                    >
                      Cancel upload
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Pending Files / Folders List */}
        {uploadFiles.length > 0 && (
          <div className={isMobile ? 'space-y-2' : 'space-y-3'}>
            <h4 className={`${isMobile ? 'text-sm' : 'text-base'} font-semibold text-gray-900 dark:text-gray-100`}>
              {isFolderUploadOnly
                ? `Folders to Upload (${folderUploadGroups.length})`
                : `Files to Upload (${uploadFiles.length})`}
            </h4>
            <div className={`space-y-2 ${isMobile ? 'max-h-32' : 'max-h-48'} overflow-y-auto`}>
              {isFolderUploadOnly
                ? folderUploadGroups.map(group => (
                    <div
                      key={group.id}
                      className={`flex items-center ${
                        isMobile ? 'space-x-2 p-2' : 'space-x-3 p-3'
                      } bg-[#f9f9f7] dark:bg-gray-700 rounded-lg`}
                    >
                      <div className="flex-shrink-0">
                        <Folder className={`${isMobile ? 'w-5 h-5' : 'w-6 h-6'} text-yellow-500`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p
                          className={`${
                            isMobile ? 'text-xs' : 'text-sm'
                          } font-medium text-gray-900 dark:text-gray-100 truncate`}
                        >
                          {group.name}
                        </p>
                        <p className={`${isMobile ? 'text-[10px]' : 'text-xs'} text-gray-500 dark:text-gray-400`}>
                          {group.fileCount} item{group.fileCount !== 1 ? 's' : ''} • {formatFileSize(group.totalSize)}
                        </p>
                      </div>
                      {!hasStartedUpload && (
                        <button
                          type="button"
                          onClick={() => removeFolderGroup(group.name)}
                          className={`flex-shrink-0 px-2.5 py-1 rounded-full text-[10px] ${
                            isMobile ? '' : 'text-xs'
                          } font-medium text-gray-700 dark:text-gray-200 bg-gray-200/80 dark:bg-gray-600/80 hover:bg-gray-300 dark:hover:bg-gray-500 transition-colors duration-150 active:scale-95`}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  ))
                : visiblePendingFiles.map(uploadFile => (
                    <div
                      key={uploadFile.id}
                      className={`flex items-center ${
                        isMobile ? 'space-x-2 p-2' : 'space-x-3 p-3'
                      } bg-[#f9f9f7] dark:bg-gray-700 rounded-lg`}
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

                      {!hasStartedUpload && (
                        <button
                          type="button"
                          onClick={() => removeFile(uploadFile.id)}
                          className={`flex-shrink-0 px-2.5 py-1 rounded-full text-[10px] ${
                            isMobile ? '' : 'text-xs'
                          } font-medium text-gray-700 dark:text-gray-200 bg-gray-200/80 dark:bg-gray-600/80 hover:bg-gray-300 dark:hover:bg-gray-500 transition-colors duration-150 active:scale-95`}
                        >
                          Remove
                        </button>
                      )}
                    </div>
                  ))}
              {!isFolderUploadOnly && hiddenPendingCount > 0 && (
                <p
                  className={`${
                    isMobile ? 'text-[10px]' : 'text-xs'
                  } text-center font-medium text-gray-500 dark:text-gray-400 py-2`}
                >
                  +{hiddenPendingCount.toLocaleString()} more file{hiddenPendingCount !== 1 ? 's' : ''}
                </p>
              )}
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
            disabled={
              uploadModalProcessing ||
              isUploading ||
              !uploadFiles.some(f => f.status === 'pending' || f.status === 'error')
            }
            className={`${
              isMobile ? 'w-full px-4 py-3 text-base font-semibold' : 'px-4 py-2 text-sm'
            } bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed active:scale-95`}
          >
            {uploadModalProcessing ? 'Preparing…' : isUploading ? 'Uploading...' : 'Upload'}
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
                  className="flex flex-col gap-3 p-4 rounded-xl bg-[#f9f9f7] dark:bg-gray-700/50 border border-gray-200 dark:border-gray-600"
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
