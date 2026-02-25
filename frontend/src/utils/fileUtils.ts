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
} from 'lucide-react';
import { format, formatDistanceToNow, isToday, isYesterday } from 'date-fns';
import bytes from 'bytes';
import mime from 'mime';
import { type FileItem } from '../contexts/AppContext';

export const getFileIcon = (file: FileItem) => {
  if (file.type === 'folder') {
    return Folder;
  }

  if (!file.mimeType) {
    return File;
  }

  const mimeType = file.mimeType.toLowerCase();

  if (mimeType.startsWith('image/')) {
    return Image;
  }

  if (mimeType.startsWith('video/')) {
    return Video;
  }

  if (mimeType.startsWith('audio/')) {
    return Music;
  }

  if (mimeType.includes('pdf') || mimeType.includes('text/')) {
    return FileText;
  }

  if (mimeType.includes('spreadsheet') || mimeType.includes('excel')) {
    return FileSpreadsheet;
  }

  if (mimeType.includes('presentation') || mimeType.includes('powerpoint')) {
    return FilePresentation;
  }

  if (mimeType.includes('zip') || mimeType.includes('archive')) {
    return Archive;
  }

  if (mimeType.includes('javascript') || mimeType.includes('html') || mimeType.includes('css')) {
    return FileCode;
  }

  return File;
};

/**
 * Format file size using bytes package for consistent formatting
 * @param size - File size in bytes (number or string)
 * @returns Formatted size string (e.g., "1.5 MB")
 */
export const formatFileSize = (size?: number | string | null): string => {
  if (!size || size === null || size === undefined) return '';
  // Convert to number if it's a string
  const numSize = typeof size === 'string' ? Number(size) : size;
  if (isNaN(numSize) || numSize <= 0) return '';
  return bytes(numSize, { decimalPlaces: 1 }) ?? '';
};

/**
 * Format date using date-fns for better date handling
 * Shows relative time for recent dates, absolute date for older ones
 * @param date - Date to format
 * @returns Formatted date string
 */
export const formatDate = (date: Date): string => {
  if (isToday(date)) {
    // Return time in 12-hour format (e.g., "2:30 PM")
    return format(date, 'h:mm a');
  }

  if (isYesterday(date)) {
    return 'Yesterday';
  }

  // For dates within the last week, show relative time
  const daysAgo = Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24));
  if (daysAgo < 7) {
    return formatDistanceToNow(date, { addSuffix: true });
  }

  // For older dates, show absolute date
  return format(date, 'MMM d, yyyy');
};

export const ONLYOFFICE_EXTS = new Set([
  '.docx',
  '.doc',
  '.docm',
  '.dotx',
  '.dotm',
  '.dot',
  '.xlsx',
  '.xls',
  '.xlsm',
  '.xlsb',
  '.xltx',
  '.xltm',
  '.csv',
  '.pptx',
  '.ppt',
  '.pptm',
  '.ppsx',
  '.ppsm',
  '.pps',
  '.potx',
  '.potm',
  '.odt',
  '.ods',
  '.odp',
  '.pdf',
]);

export function getExt(name?: string) {
  if (!name) return '';
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}

/**
 * Returns the name to display for a file/folder. When hideExtensions is true and item is a file
 * with an extension, returns the name without the extension (e.g. "report" instead of "report.pdf").
 */
export function getDisplayFileName(name: string, isFile: boolean, hideExtensions: boolean): string {
  if (!name) return '';
  if (!hideExtensions || !isFile) return name;
  const ext = getExt(name);
  if (!ext) return name;
  return name.slice(0, name.length - ext.length);
}

/**
 * When extensions were hidden in the rename dialog, the user edits only the base name.
 * This appends the original file's extension back to produce the full name to send to the API.
 */
export function getFullNameForRename(editedDisplayName: string, originalFullName: string): string {
  const trimmed = editedDisplayName.trim();
  const ext = getExt(originalFullName);
  if (!ext) return trimmed;
  return trimmed + ext;
}

export const isOnlyOfficeSupported = (name?: string) => ONLYOFFICE_EXTS.has(getExt(name));

/**
 * Validates if a file's MIME type matches the expected type for its extension
 * Uses mime package to get expected MIME types dynamically
 * @param fileName - File name with extension
 * @param mimeType - File's MIME type
 * @returns true if MIME type matches expected type for the extension
 */
export const validateOnlyOfficeMimeType = (fileName: string, mimeType?: string | null): boolean => {
  if (!mimeType) return false;

  const ext = getExt(fileName);
  const expectedMime = mime.getType(ext);
  if (!expectedMime) return false;

  const mimePart = mimeType.toLowerCase().split(';')[0];
  if (!mimePart) return false;
  const normalizedMime = mimePart.trim();
  const normalizedExpected = expectedMime.toLowerCase();

  // Check primary MIME type
  if (normalizedMime === normalizedExpected) return true;

  // Special case: CSV can be text/plain or application/csv
  if (ext === '.csv') {
    return normalizedMime === 'text/plain' || normalizedMime === 'application/csv';
  }

  return false;
};

/**
 * Formats a filename for tooltip display in the format: "filename...extension"
 * @param filename The full filename
 * @param maxLength Maximum length before truncation (default: 30)
 * @returns Formatted string like "filenam...ext" or full name if short enough
 */
export const formatFileNameForTooltip = (filename: string, maxLength: number = 30): string => {
  if (!filename) return '';

  // If filename is short enough, return as is
  if (filename.length <= maxLength) {
    return filename;
  }

  const extension = getExt(filename);
  const nameWithoutExt = extension ? filename.slice(0, -extension.length) : filename;

  // If no extension, just truncate with ellipsis
  if (!extension) {
    return filename.slice(0, maxLength - 3) + '...';
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
