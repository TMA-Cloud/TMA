import React from 'react';
import type { TransferItem } from '../../utils/transferUtils';
import { TransferProgress } from '../transfer/TransferProgress';

interface DownloadProgressProps {
  downloads: TransferItem[];
  onDismiss: (id: string) => void;
  onCancel?: (id: string) => void;
  onInteractionChange?: (isInteracting: boolean) => void;
}

/** Download progress stack — the shared transfer UI in the "download" direction. */
export const DownloadProgress: React.FC<DownloadProgressProps> = ({
  downloads,
  onDismiss,
  onCancel,
  onInteractionChange,
}) => (
  <TransferProgress
    items={downloads}
    direction="download"
    onDismiss={onDismiss}
    onCancel={onCancel}
    onInteractionChange={onInteractionChange}
    position="right"
  />
);
