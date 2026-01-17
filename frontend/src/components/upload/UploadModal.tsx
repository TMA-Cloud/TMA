import React, { useState, useRef } from "react";
import { Upload, X, File, CheckCircle, AlertCircle } from "lucide-react";
import { Modal } from "../ui/Modal";
import { useApp } from "../../contexts/AppContext";
import { formatFileSize } from "../../utils/fileUtils";
import { useIsMobile } from "../../hooks/useIsMobile";
import { useToast } from "../../hooks/useToast";

interface UploadFile {
  id: string;
  file: File;
  progress: number;
  status: "pending" | "uploading" | "completed" | "error";
}

export const UploadModal: React.FC = () => {
  const {
    uploadModalOpen,
    setUploadModalOpen,
    uploadFileWithProgress,
    uploadProgress,
    agentOnline,
  } = useApp();
  const { showToast } = useToast();
  const [uploadFiles, setUploadFiles] = useState<UploadFile[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isMobile = useIsMobile();

  const handleFiles = (files: FileList) => {
    const newUploadFiles: UploadFile[] = Array.from(files).map(
      (file, index) => ({
        id: `${Date.now()}-${index}`,
        file,
        progress: 0,
        status: "pending" as const,
      }),
    );

    setUploadFiles((prev) => [...prev, ...newUploadFiles]);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);

    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFiles(files);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) {
      handleFiles(files);
    }
  };

  const removeFile = (fileId: string) => {
    setUploadFiles((prev) => prev.filter((f) => f.id !== fileId));
  };

  const handleClose = () => {
    setUploadModalOpen(false);
    // Don't clear files on close - keep them for when user reopens modal
  };

  const startUpload = async () => {
    if (uploadFiles.length === 0) return;

    if (agentOnline === false) {
      showToast(
        "Agent is offline. Please refresh agent connection in Settings.",
        "error",
      );
      return;
    }

    // Close the modal immediately when upload starts
    setUploadModalOpen(false);

    setIsUploading(true);
    try {
      // Start all pending uploads
      const uploadPromises = uploadFiles
        .filter((f) => f.status === "pending" || f.status === "error")
        .map((uploadFileItem) =>
          uploadFileWithProgress(uploadFileItem.file).catch(() => {
            // Error handled by upload progress UI
          }),
        );

      await Promise.all(uploadPromises);
      // Clear files that were successfully started (they're now in global uploadProgress)
      // Keep files with errors so user can retry
      setUploadFiles((prev) => prev.filter((f) => f.status === "error"));
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <Modal
      isOpen={uploadModalOpen}
      onClose={handleClose}
      title="Upload Files"
      size={isMobile ? "full" : "lg"}
    >
      <div className={isMobile ? "space-y-4" : "space-y-6"}>
        {/* Drop Zone */}
        <div
          className={`
            relative border-2 border-dashed rounded-lg text-center transition-colors duration-200
            ${
              isMobile
                ? "p-6 min-h-[180px] flex items-center justify-center"
                : "p-8"
            }
            ${
              isDragOver
                ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
                : "border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500"
            }
          `}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={handleFileInput}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          />

          <div className={`${isMobile ? "space-y-3" : "space-y-4"} w-full`}>
            <div
              className={`mx-auto ${
                isMobile ? "w-12 h-12" : "w-16 h-16"
              } bg-gray-100 dark:bg-gray-700 rounded-full flex items-center justify-center`}
            >
              <Upload
                className={`${isMobile ? "w-6 h-6" : "w-8 h-8"} text-gray-400`}
              />
            </div>

            <div>
              <p
                className={`${
                  isMobile ? "text-base" : "text-lg"
                } font-medium text-gray-900 dark:text-gray-100`}
              >
                {isMobile ? "Tap to select files" : "Drag and drop files here"}
              </p>
              <p
                className={`${
                  isMobile ? "text-xs" : "text-sm"
                } text-gray-500 dark:text-gray-400 mt-1`}
              >
                {isMobile
                  ? "or browse from your device"
                  : "or click to browse from your computer"}
              </p>
            </div>
          </div>
        </div>

        {/* Active Uploads from Global State */}
        {uploadProgress.filter((u) => u.status === "uploading").length > 0 && (
          <div className={isMobile ? "space-y-2" : "space-y-3"}>
            <h4
              className={`${
                isMobile ? "text-sm" : "text-base"
              } font-semibold text-gray-900 dark:text-gray-100`}
            >
              Uploading (
              {uploadProgress.filter((u) => u.status === "uploading").length})
            </h4>
            <div
              className={`space-y-2 ${
                isMobile ? "max-h-32" : "max-h-48"
              } overflow-y-auto`}
            >
              {uploadProgress
                .filter((u) => u.status === "uploading")
                .map((upload) => (
                  <div
                    key={upload.id}
                    className={`flex items-center ${
                      isMobile ? "space-x-2 p-2" : "space-x-3 p-3"
                    } bg-blue-50 dark:bg-blue-900/20 rounded-lg border border-blue-200 dark:border-blue-800`}
                  >
                    <div className="flex-shrink-0">
                      <div
                        className={`${
                          isMobile ? "w-7 h-7" : "w-8 h-8"
                        } rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center`}
                      >
                        <Upload
                          className={`${
                            isMobile ? "w-3.5 h-3.5" : "w-4 h-4"
                          } text-blue-600 dark:text-blue-400 animate-pulse`}
                        />
                      </div>
                    </div>

                    <div className="flex-1 min-w-0">
                      <p
                        className={`${
                          isMobile ? "text-xs" : "text-sm"
                        } font-medium text-gray-900 dark:text-gray-100 truncate`}
                      >
                        {upload.fileName}
                      </p>
                      <div className="flex items-center justify-between mt-0.5">
                        <p
                          className={`${
                            isMobile ? "text-[10px]" : "text-xs"
                          } text-gray-500 dark:text-gray-400`}
                        >
                          {formatFileSize(upload.fileSize)}
                        </p>
                        <p
                          className={`${
                            isMobile ? "text-[10px]" : "text-xs"
                          } font-semibold text-blue-600 dark:text-blue-400`}
                        >
                          {upload.progress}%
                        </p>
                      </div>
                      <div className={isMobile ? "mt-1.5" : "mt-2"}>
                        <div
                          className={`bg-gray-200 dark:bg-gray-700 rounded-full ${
                            isMobile ? "h-1" : "h-1.5"
                          } overflow-hidden`}
                        >
                          <div
                            className={`bg-gradient-to-r from-blue-500 to-blue-600 ${
                              isMobile ? "h-1" : "h-1.5"
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
          <div className={isMobile ? "space-y-2" : "space-y-3"}>
            <h4
              className={`${
                isMobile ? "text-sm" : "text-base"
              } font-semibold text-gray-900 dark:text-gray-100`}
            >
              Files to Upload ({uploadFiles.length})
            </h4>
            <div
              className={`space-y-2 ${
                isMobile ? "max-h-32" : "max-h-48"
              } overflow-y-auto`}
            >
              {uploadFiles.map((uploadFile) => (
                <div
                  key={uploadFile.id}
                  className={`flex items-center ${
                    isMobile ? "space-x-2 p-2" : "space-x-3 p-3"
                  } bg-gray-50 dark:bg-gray-700 rounded-lg`}
                >
                  <div className="flex-shrink-0">
                    {uploadFile.status === "completed" ? (
                      <CheckCircle
                        className={`${
                          isMobile ? "w-5 h-5" : "w-6 h-6"
                        } text-green-500`}
                      />
                    ) : uploadFile.status === "error" ? (
                      <AlertCircle
                        className={`${
                          isMobile ? "w-5 h-5" : "w-6 h-6"
                        } text-red-500`}
                      />
                    ) : (
                      <File
                        className={`${
                          isMobile ? "w-5 h-5" : "w-6 h-6"
                        } text-gray-400`}
                      />
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <p
                      className={`${
                        isMobile ? "text-xs" : "text-sm"
                      } font-medium text-gray-900 dark:text-gray-100 truncate`}
                    >
                      {uploadFile.file.name}
                    </p>
                    <p
                      className={`${
                        isMobile ? "text-[10px]" : "text-xs"
                      } text-gray-500 dark:text-gray-400`}
                    >
                      {formatFileSize(uploadFile.file.size)}
                    </p>

                    {uploadFile.status === "uploading" && (
                      <div className={isMobile ? "mt-1" : "mt-1"}>
                        <div
                          className={`bg-gray-200 dark:bg-gray-600 rounded-full ${
                            isMobile ? "h-1" : "h-1"
                          }`}
                        >
                          <div
                            className={`bg-blue-500 ${
                              isMobile ? "h-1" : "h-1"
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
                      isMobile ? "p-1.5" : ""
                    } text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors active:scale-95`}
                    aria-label="Remove file"
                  >
                    <X className={`${isMobile ? "w-4 h-4" : "w-4 h-4"}`} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Actions */}
        <div
          className={`flex ${
            isMobile
              ? "flex-col-reverse space-y-reverse space-y-2"
              : "justify-end space-x-3"
          }`}
        >
          <button
            onClick={handleClose}
            className={`${
              isMobile ? "w-full px-4 py-3 text-base" : "px-4 py-2 text-sm"
            } text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors duration-200 active:scale-95`}
          >
            Close
          </button>
          <button
            onClick={startUpload}
            disabled={
              isUploading ||
              !uploadFiles.some(
                (f) => f.status === "pending" || f.status === "error",
              )
            }
            className={`${
              isMobile
                ? "w-full px-4 py-3 text-base font-semibold"
                : "px-4 py-2 text-sm"
            } bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed active:scale-95`}
          >
            {isUploading ? "Uploading..." : "Upload"}
          </button>
        </div>
      </div>
    </Modal>
  );
};
