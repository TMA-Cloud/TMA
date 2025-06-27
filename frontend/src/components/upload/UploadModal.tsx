import React, { useState, useRef } from "react";
import { Upload, X, File, CheckCircle } from "lucide-react";
import { Modal } from "../ui/Modal";
import { useApp } from "../../contexts/AppContext";

interface UploadFile {
  id: string;
  file: File;
  progress: number;
  status: "pending" | "uploading" | "completed" | "error";
}

export const UploadModal: React.FC = () => {
  const { uploadModalOpen, setUploadModalOpen, uploadFile } = useApp();
  const [uploadFiles, setUploadFiles] = useState<UploadFile[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const formatFileSize = (bytes: number) => {
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  };

  const handleClose = () => {
    setUploadModalOpen(false);
    setTimeout(() => setUploadFiles([]), 300);
  };

  const startUpload = async () => {
    setIsUploading(true);
    for (const uploadFileItem of uploadFiles) {
      if (
        uploadFileItem.status !== "pending" &&
        uploadFileItem.status !== "error"
      )
        continue;
      setUploadFiles((prev) =>
        prev.map((f) =>
          f.id === uploadFileItem.id
            ? { ...f, status: "uploading" as const }
            : f,
        ),
      );
      try {
        await uploadFile(uploadFileItem.file);
        setUploadFiles((prev) =>
          prev.map((f) =>
            f.id === uploadFileItem.id
              ? { ...f, progress: 100, status: "completed" as const }
              : f,
          ),
        );
      } catch {
        setUploadFiles((prev) =>
          prev.map((f) =>
            f.id === uploadFileItem.id ? { ...f, status: "error" as const } : f,
          ),
        );
      }
    }
    setIsUploading(false);
  };

  return (
    <Modal
      isOpen={uploadModalOpen}
      onClose={handleClose}
      title="Upload Files"
      size="lg"
    >
      <div className="space-y-6">
        {/* Drop Zone */}
        <div
          className={`
            relative border-2 border-dashed rounded-lg p-8 text-center transition-colors duration-200
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

          <div className="space-y-4">
            <div className="mx-auto w-16 h-16 bg-gray-100 dark:bg-gray-700 rounded-full flex items-center justify-center">
              <Upload className="w-8 h-8 text-gray-400" />
            </div>

            <div>
              <p className="text-lg font-medium text-gray-900 dark:text-gray-100">
                Drag and drop files here
              </p>
              <p className="text-gray-500 dark:text-gray-400">
                or click to browse from your computer
              </p>
            </div>
          </div>
        </div>

        {/* Upload List */}
        {uploadFiles.length > 0 && (
          <div className="space-y-3 max-h-64 overflow-y-auto">
            <h4 className="font-medium text-gray-900 dark:text-gray-100">
              Files ({uploadFiles.length})
            </h4>

            {uploadFiles.map((uploadFile) => (
              <div
                key={uploadFile.id}
                className="flex items-center space-x-3 p-3 bg-gray-50 dark:bg-gray-700 rounded-lg"
              >
                <div className="flex-shrink-0">
                  {uploadFile.status === "completed" ? (
                    <CheckCircle className="w-6 h-6 text-green-500" />
                  ) : (
                    <File className="w-6 h-6 text-gray-400" />
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                    {uploadFile.file.name}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {formatFileSize(uploadFile.file.size)}
                  </p>

                  {uploadFile.status === "uploading" && (
                    <div className="mt-1">
                      <div className="bg-gray-200 dark:bg-gray-600 rounded-full h-1">
                        <div
                          className="bg-blue-500 h-1 rounded-full transition-all duration-300"
                          style={{ width: `${uploadFile.progress}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>

                <button
                  onClick={() => removeFile(uploadFile.id)}
                  className="flex-shrink-0 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-end space-x-3">
          <button
            onClick={startUpload}
            disabled={
              isUploading ||
              !uploadFiles.some(
                (f) => f.status === "pending" || f.status === "error",
              )
            }
            className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isUploading ? "Uploading..." : "Upload"}
          </button>
          <button
            onClick={handleClose}
            className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors duration-200"
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
};
