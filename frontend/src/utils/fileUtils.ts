import {
  FileText,
  Image,
  Video,
  Music,
  Archive,
  File,
  Folder,
  FileSpreadsheet,
  Presentation as FilePresentation,
  FileCode,
} from "lucide-react";
import { type FileItem } from "../contexts/AppContext";

export const getFileIcon = (file: FileItem) => {
  if (file.type === "folder") {
    return Folder;
  }

  if (!file.mimeType) {
    return File;
  }

  const mimeType = file.mimeType.toLowerCase();

  if (mimeType.startsWith("image/")) {
    return Image;
  }

  if (mimeType.startsWith("video/")) {
    return Video;
  }

  if (mimeType.startsWith("audio/")) {
    return Music;
  }

  if (mimeType.includes("pdf") || mimeType.includes("text/")) {
    return FileText;
  }

  if (mimeType.includes("spreadsheet") || mimeType.includes("excel")) {
    return FileSpreadsheet;
  }

  if (mimeType.includes("presentation") || mimeType.includes("powerpoint")) {
    return FilePresentation;
  }

  if (mimeType.includes("zip") || mimeType.includes("archive")) {
    return Archive;
  }

  if (
    mimeType.includes("javascript") ||
    mimeType.includes("html") ||
    mimeType.includes("css")
  ) {
    return FileCode;
  }

  return File;
};

export const formatFileSize = (bytes?: number): string => {
  if (!bytes) return "";

  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
};

export const formatDate = (date: Date): string => {
  const now = new Date();
  const diffTime = Math.abs(now.getTime() - date.getTime());
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays === 1) {
    return "Yesterday";
  } else if (diffDays < 7) {
    return `${diffDays} days ago`;
  } else {
    return date.toLocaleDateString();
  }
};

export const ONLYOFFICE_EXTS = new Set([
  ".docx",
  ".doc",
  ".docm",
  ".dotx",
  ".dotm",
  ".dot",
  ".xlsx",
  ".xls",
  ".xlsm",
  ".xlsb",
  ".xltx",
  ".xltm",
  ".csv",
  ".pptx",
  ".ppt",
  ".pptm",
  ".ppsx",
  ".ppsm",
  ".pps",
  ".potx",
  ".potm",
  ".odt",
  ".ods",
  ".odp",
  ".pdf",
]);

function getExt(name?: string) {
  if (!name) return "";
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx).toLowerCase() : "";
}

export const isOnlyOfficeSupported = (name?: string) =>
  ONLYOFFICE_EXTS.has(getExt(name));
