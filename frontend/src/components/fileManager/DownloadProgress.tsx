import React from 'react';
import { Download } from 'lucide-react';
import { FixedProgress } from './FixedProgress';

interface DownloadProgressProps {
  isDownloading: boolean;
  hasFolders: boolean;
}

export const DownloadProgress: React.FC<DownloadProgressProps> = ({ isDownloading, hasFolders }) => {
  if (!isDownloading) return null;

  return (
    <FixedProgress
      icon={Download}
      title={hasFolders ? 'Zipping and downloading...' : 'Downloading...'}
      variant="blue-pulse"
    />
  );
};
