import React, { useState, useEffect, useRef } from 'react';
import { Upload, Download, X, ChevronDown, ChevronUp } from 'lucide-react';
import { useIsMobile } from '../../hooks/useIsMobile';
import type { TransferItem, TransferStatus } from '../../utils/transferUtils';
import { TransferItemCard, type TransferDirection } from './TransferItemCard';

interface TransferProgressProps {
  items: TransferItem[];
  direction: TransferDirection;
  onDismiss: (id: string) => void;
  onInteractionChange?: (isInteracting: boolean) => void;
  onCancel?: (id: string) => void;
  position?: 'right' | 'left';
}

const MAX_INDIVIDUAL_ITEMS = 2;
const MAX_VISIBLE_IN_EXPANDED = 5;

const isInFlight = (s: TransferStatus) =>
  s === 'uploading' || s === 'downloading' || s === 'finalizing' || s === 'zipping';
const isPreparing = (s: TransferStatus) => s === 'finalizing' || s === 'zipping';

/**
 * Bottom-pinned transfer stack shared by uploads and downloads. 1–2 items render
 * as individual cards; 3+ collapse into a summary card with an expandable list.
 * All per-row visuals come from {@link TransferItemCard} so both directions match.
 */
export const TransferProgress: React.FC<TransferProgressProps> = ({
  items,
  direction,
  onDismiss,
  onInteractionChange,
  onCancel,
  position = 'right',
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isScrolling, setIsScrolling] = useState(false);
  const scrollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();

  useEffect(() => {
    onInteractionChange?.(isHovered || isScrolling);
  }, [isHovered, isScrolling, onInteractionChange]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !isExpanded) return;

    const bump = () => {
      setIsScrolling(true);
      if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
      scrollTimeoutRef.current = setTimeout(() => setIsScrolling(false), 1000);
    };

    container.addEventListener('scroll', bump);
    container.addEventListener('mousemove', bump);
    return () => {
      container.removeEventListener('scroll', bump);
      container.removeEventListener('mousemove', bump);
      if (scrollTimeoutRef.current) clearTimeout(scrollTimeoutRef.current);
    };
  }, [isExpanded]);

  if (items.length === 0) return null;

  const verb = direction === 'upload' ? 'uploading' : 'downloading';
  const HeaderIcon = direction === 'upload' ? Upload : Download;
  const wrapperPos = isMobile
    ? 'bottom-20 left-2 right-2 w-auto'
    : position === 'left'
      ? 'bottom-4 left-4 w-96'
      : 'bottom-4 right-4 w-96';

  const inFlight = items.filter(i => isInFlight(i.status));
  const completed = items.filter(i => i.status === 'completed');
  const errors = items.filter(i => i.status === 'error');

  const hasIndeterminate = inFlight.some(i => i.indeterminate);
  const anyPreparing = inFlight.some(i => isPreparing(i.status));
  const totalProgress =
    inFlight.length > 0 ? Math.round(inFlight.reduce((sum, i) => sum + i.progress, 0) / inFlight.length) : 100;
  const overallIndeterminate = hasIndeterminate;
  const overallLabel = anyPreparing
    ? direction === 'upload'
      ? 'Finalizing upload...'
      : 'Zipping...'
    : overallIndeterminate
      ? direction === 'upload'
        ? 'Uploading...'
        : 'Downloading...'
      : `${totalProgress}%`;

  // 1–2 items: individual cards
  if (items.length <= MAX_INDIVIDUAL_ITEMS) {
    return (
      <div
        className={`fixed z-50 ${wrapperPos} space-y-2`}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {items.map((item, index) => (
          <div
            key={item.id}
            className={`bg-[#ffffff] dark:bg-gray-900 border border-gray-200/50 dark:border-gray-700/50 rounded-xl shadow-xl backdrop-blur-xl transition-all duration-300 ease-out animate-fadeIn ${
              isMobile ? 'p-3' : 'p-4 hover:shadow-2xl'
            }`}
            style={{ animationDelay: `${index * 50}ms`, transform: 'translateY(0)' }}
          >
            <TransferItemCard
              fileName={item.fileName}
              fileSize={item.fileSize}
              status={item.status}
              progress={item.progress}
              indeterminate={item.indeterminate}
              direction={direction}
              variant="card"
              isMobile={isMobile}
              onCancel={onCancel ? () => onCancel(item.id) : undefined}
            />
          </div>
        ))}
      </div>
    );
  }

  // 3+ items: summary card + expandable list
  const visibleItems = isExpanded ? items.slice(0, MAX_VISIBLE_IN_EXPANDED) : [];
  const remainingCount = items.length - visibleItems.length;

  return (
    <div
      className={`fixed z-50 ${wrapperPos}`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div
        className={`bg-[#ffffff] dark:bg-gray-900 border border-gray-200/50 dark:border-gray-700/50 rounded-xl shadow-xl backdrop-blur-xl transition-all duration-300 ease-out animate-fadeIn overflow-hidden ${
          isMobile ? '' : 'hover:shadow-2xl'
        }`}
        style={{ transform: 'translateY(0) scale(1)' }}
      >
        <div
          className={`${
            isMobile ? 'px-3 py-3' : 'px-5 py-4'
          } border-b border-gray-100 dark:border-gray-800/50 bg-[var(--fill-quaternary)]`}
        >
          <div className="flex items-center justify-between">
            <div className={`flex items-center ${isMobile ? 'space-x-2' : 'space-x-3'}`}>
              <div
                className={`${
                  isMobile ? 'w-8 h-8' : 'w-10 h-10'
                } rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center`}
              >
                <HeaderIcon className={`${isMobile ? 'w-4 h-4' : 'w-5 h-5'} text-blue-600 dark:text-blue-400`} />
              </div>
              <div>
                <p className={`${isMobile ? 'text-xs' : 'text-sm'} font-bold text-gray-900 dark:text-gray-100`}>
                  {inFlight.length > 0
                    ? `${inFlight.length} ${verb}`
                    : completed.length > 0
                      ? `${completed.length} completed`
                      : `${errors.length} failed`}
                </p>
                <p className={`${isMobile ? 'text-[10px]' : 'text-xs'} text-gray-500 dark:text-gray-400 mt-0.5`}>
                  {completed.length > 0 && `${completed.length} completed`}
                  {completed.length > 0 && errors.length > 0 && ' • '}
                  {errors.length > 0 && `${errors.length} failed`}
                </p>
              </div>
            </div>
            <button
              onClick={() => completed.forEach(i => onDismiss(i.id))}
              className={`${
                isMobile ? 'w-7 h-7' : 'w-8 h-8'
              } rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-all duration-200 active:scale-95 touch-manipulation`}
              title="Dismiss all completed"
            >
              <X className={`${isMobile ? 'w-3.5 h-3.5' : 'w-4 h-4'}`} />
            </button>
          </div>

          {inFlight.length > 0 && (
            <div className={isMobile ? 'mt-3' : 'mt-4'}>
              <div className={`flex items-center justify-between ${isMobile ? 'mb-1' : 'mb-1.5'}`}>
                <p className={`${isMobile ? 'text-[10px]' : 'text-xs'} font-medium text-gray-700 dark:text-gray-300`}>
                  Overall progress
                </p>
                <p className={`${isMobile ? 'text-[10px]' : 'text-xs'} font-bold text-blue-600 dark:text-blue-400`}>
                  {overallLabel}
                </p>
              </div>
              <div
                className={`bg-gray-100 dark:bg-gray-800 rounded-full ${isMobile ? 'h-1.5' : 'h-2'} overflow-hidden`}
              >
                <div
                  className={`${isMobile ? 'h-1.5' : 'h-2'} rounded-full shadow-sm ${
                    overallIndeterminate
                      ? 'bg-blue-500 animate-pulse'
                      : 'bg-[var(--accent)] transition-all duration-500 ease-out'
                  }`}
                  style={{ width: overallIndeterminate ? '100%' : `${totalProgress}%` }}
                />
              </div>
            </div>
          )}
        </div>

        <div
          ref={containerRef}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setIsHovered(false)}
          className={`${isMobile ? 'max-h-48' : 'max-h-64'} overflow-y-auto transition-all duration-300 ease-out ${
            isExpanded ? `opacity-100 ${isMobile ? 'max-h-48' : 'max-h-64'}` : 'opacity-0 max-h-0 overflow-hidden'
          }`}
        >
          {visibleItems.map((item, index) => (
            <div
              key={item.id}
              className={`${
                isMobile ? 'px-3 py-2' : 'px-5 py-3'
              } border-b border-gray-100 dark:border-gray-800/50 last:border-b-0 hover:bg-[#ffffff]/50 dark:hover:bg-gray-800/30 transition-all duration-200 ease-out`}
              style={{ animationDelay: `${index * 30}ms` }}
            >
              <TransferItemCard
                fileName={item.fileName}
                fileSize={item.fileSize}
                status={item.status}
                progress={item.progress}
                indeterminate={item.indeterminate}
                direction={direction}
                variant="row"
                isMobile={isMobile}
                onCancel={onCancel ? () => onCancel(item.id) : undefined}
              />
            </div>
          ))}

          {remainingCount > 0 && (
            <div
              className={`${isMobile ? 'px-3 py-2' : 'px-5 py-3'} text-center ${
                isMobile ? 'text-[10px]' : 'text-xs'
              } font-medium text-gray-500 dark:text-gray-400 bg-[#ffffff]/50 dark:bg-gray-800/30`}
            >
              +{remainingCount} more file{remainingCount !== 1 ? 's' : ''}
            </div>
          )}
        </div>

        <button
          onClick={() => setIsExpanded(!isExpanded)}
          onMouseEnter={() => setIsHovered(true)}
          onMouseLeave={() => setTimeout(() => setIsHovered(false), 100)}
          className={`w-full ${isMobile ? 'px-3 py-2.5' : 'px-5 py-3'} ${
            isMobile ? 'text-xs' : 'text-sm'
          } font-medium text-gray-700 dark:text-gray-300 hover:bg-[#ffffff] dark:hover:bg-gray-800/50 transition-all duration-200 flex items-center justify-center space-x-2 border-t border-gray-100 dark:border-gray-800/50 active:scale-95 touch-manipulation`}
        >
          {isExpanded ? (
            <>
              <span>Show less</span>
              <ChevronUp className={`${isMobile ? 'w-3.5 h-3.5' : 'w-4 h-4'}`} />
            </>
          ) : (
            <>
              <span>
                Show {items.length} file{items.length !== 1 ? 's' : ''}
              </span>
              <ChevronDown className={`${isMobile ? 'w-3.5 h-3.5' : 'w-4 h-4'}`} />
            </>
          )}
        </button>
      </div>
    </div>
  );
};
