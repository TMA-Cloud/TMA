import React from 'react';
import { Upload, Download, X, CheckCircle, AlertCircle, Loader2 } from 'lucide-react';
import { formatFileSize } from '../../utils/fileUtils';
import type { TransferStatus } from '../../utils/transferUtils';

export type TransferDirection = 'upload' | 'download';

/** `card` = the richer standalone card (1–2 items); `row` = the compact list row (3+ items). */
export type TransferCardVariant = 'card' | 'row';

interface TransferItemCardProps {
  fileName: string;
  fileSize: number;
  status: TransferStatus;
  progress: number;
  indeterminate?: boolean;
  direction: TransferDirection;
  variant?: TransferCardVariant;
  isMobile: boolean;
  onCancel?: () => void;
}

const isActive = (s: TransferStatus) => s === 'uploading' || s === 'downloading';
const isPreparing = (s: TransferStatus) => s === 'finalizing' || s === 'zipping';
const isInFlight = (s: TransferStatus) => isActive(s) || isPreparing(s);

/** The small right-aligned status text shown next to the file size while in flight. */
function inFlightLabel(
  status: TransferStatus,
  direction: TransferDirection,
  progress: number,
  indeterminate?: boolean
) {
  if (status === 'finalizing') return direction === 'upload' ? 'Finalizing upload...' : 'Finalizing...';
  if (status === 'zipping') return 'Zipping...';
  if (indeterminate) return direction === 'upload' ? 'Uploading...' : 'Downloading...';
  return `${progress}%`;
}

/**
 * One transfer row, shared by the upload and download progress stacks so both
 * read identically. The only differences are the direction icon/verbs and the
 * two size presets (`card` vs `row`).
 */
export const TransferItemCard: React.FC<TransferItemCardProps> = ({
  fileName,
  fileSize,
  status,
  progress,
  indeterminate,
  direction,
  variant = 'card',
  isMobile,
  onCancel,
}) => {
  const isCard = variant === 'card';
  const circle = isCard ? (isMobile ? 'w-8 h-8' : 'w-10 h-10') : isMobile ? 'w-7 h-7' : 'w-8 h-8';
  const glyph = isCard ? (isMobile ? 'w-4 h-4' : 'w-5 h-5') : isMobile ? 'w-3.5 h-3.5' : 'w-4 h-4';
  const smallText = isMobile ? 'text-[10px]' : 'text-xs';
  const nameText = `${isMobile ? 'text-xs' : 'text-sm'} ${isCard ? 'font-semibold' : 'font-medium'}`;
  const ActiveIcon = direction === 'upload' ? Upload : Download;

  return (
    <div className={`flex items-center ${isMobile ? 'space-x-2' : 'space-x-3'}`}>
      <div className="flex-shrink-0">
        {status === 'completed' ? (
          <div className={`${circle} rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center`}>
            <CheckCircle className={`${glyph} text-green-600 dark:text-green-400`} />
          </div>
        ) : status === 'error' ? (
          <div className={`${circle} rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center`}>
            <AlertCircle className={`${glyph} text-red-600 dark:text-red-400`} />
          </div>
        ) : isPreparing(status) ? (
          <div className={`${circle} rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center`}>
            <Loader2 className={`${glyph} text-blue-600 dark:text-blue-400 animate-spin`} />
          </div>
        ) : (
          <div className={`${circle} rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center`}>
            <ActiveIcon className={`${glyph} text-blue-600 dark:text-blue-400 animate-pulse`} />
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <p className={`${nameText} text-gray-900 dark:text-gray-100 truncate`}>{fileName}</p>
        <div className={`flex items-center justify-between ${isCard ? 'mt-0.5' : 'mt-1'}`}>
          <p className={`${smallText} text-gray-500 dark:text-gray-400`}>
            {fileSize > 0 ? formatFileSize(fileSize) : ''}
          </p>
          {isInFlight(status) && (
            <p className={`${smallText} font-medium text-blue-600 dark:text-blue-400`}>
              {inFlightLabel(status, direction, progress, indeterminate)}
            </p>
          )}
        </div>

        {isInFlight(status) && (
          <div className={isCard ? (isMobile ? 'mt-2' : 'mt-2.5') : isMobile ? 'mt-1.5' : 'mt-2'}>
            <div className={`bg-gray-100 dark:bg-gray-800 rounded-full ${isMobile ? 'h-1' : 'h-1.5'} overflow-hidden`}>
              <div
                className={`${isMobile ? 'h-1' : 'h-1.5'} rounded-full shadow-sm ${
                  indeterminate
                    ? 'bg-blue-500 animate-pulse'
                    : 'bg-[var(--accent)] transition-all duration-500 ease-out'
                }`}
                style={{ width: indeterminate ? '100%' : `${progress}%` }}
              />
            </div>
          </div>
        )}

        {isCard && status === 'completed' && (
          <p className={`${smallText} font-medium text-green-600 dark:text-green-400 ${isMobile ? 'mt-1' : 'mt-1.5'}`}>
            Completed
          </p>
        )}
        {isCard && status === 'error' && (
          <p className={`${smallText} font-medium text-red-600 dark:text-red-400 ${isMobile ? 'mt-1' : 'mt-1.5'}`}>
            Failed
          </p>
        )}
      </div>

      {isInFlight(status) && onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className={`${isCard ? '' : 'ml-2'} flex-shrink-0 ${
            isMobile ? 'w-7 h-7' : 'w-8 h-8'
          } rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-all duration-200 active:scale-95`}
          title={direction === 'upload' ? 'Cancel upload' : 'Cancel download'}
        >
          <X className={`${isMobile ? 'w-3.5 h-3.5' : 'w-4 h-4'}`} />
        </button>
      )}
    </div>
  );
};
