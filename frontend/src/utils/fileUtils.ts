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

  // Check if it's today (same day, month, year)
  const isToday =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();

  if (isToday) {
    // Return time in 12-hour format (e.g., "2:30 PM")
    return date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  }

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

export function getExt(name?: string) {
  if (!name) return "";
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx).toLowerCase() : "";
}

export const isOnlyOfficeSupported = (name?: string) =>
  ONLYOFFICE_EXTS.has(getExt(name));

/**
 * Formats a filename for tooltip display in the format: "filename...extension"
 * @param filename The full filename
 * @param maxLength Maximum length before truncation (default: 30)
 * @returns Formatted string like "filenam...ext" or full name if short enough
 */
export const formatFileNameForTooltip = (
  filename: string,
  maxLength: number = 30,
): string => {
  if (!filename) return "";

  // If filename is short enough, return as is
  if (filename.length <= maxLength) {
    return filename;
  }

  const extension = getExt(filename);
  const nameWithoutExt = extension
    ? filename.slice(0, -extension.length)
    : filename;

  // If no extension, just truncate with ellipsis
  if (!extension) {
    return filename.slice(0, maxLength - 3) + "...";
  }

  // Calculate available space for name part (reserve space for "..." + extension)
  const reservedSpace = 3 + extension.length; // "..." + extension
  const nameMaxLength = Math.max(5, maxLength - reservedSpace); // At least 5 chars for name

  if (nameWithoutExt.length <= nameMaxLength) {
    return filename; // Fits within maxLength
  }

  // Format as "name...ext"
  const truncatedName = nameWithoutExt.slice(0, nameMaxLength);
  return `${truncatedName}...${extension}`;
};
