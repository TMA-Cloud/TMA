import React from 'react';
import type { UploadProgressItem } from '../../utils/uploadUtils';
import { TransferProgress } from '../transfer/TransferProgress';

interface UploadProgressProps {
  uploads: UploadProgressItem[];
  onDismiss: (id: string) => void;
  onInteractionChange?: (isInteracting: boolean) => void;
  onCancel?: (id: string) => void;
}

/** Upload progress stack — the shared transfer UI in the "upload" direction. */
export const UploadProgress: React.FC<UploadProgressProps> = ({
  uploads,
  onDismiss,
  onInteractionChange,
  onCancel,
}) => (
  <TransferProgress
    items={uploads}
    direction="upload"
    onDismiss={onDismiss}
    onInteractionChange={onInteractionChange}
    onCancel={onCancel}
    position="right"
  />
);
