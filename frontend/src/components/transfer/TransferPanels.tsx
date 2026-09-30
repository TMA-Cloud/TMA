import React from 'react';
import { useApp } from '../../contexts/AppContext';
import { useStore } from '../../utils/store';
import { UploadProgress } from '../upload/UploadProgress';
import { DownloadProgress } from '../fileManager/DownloadProgress';

/** The only subscriber to transfer progress, so ticks re-render just these stacks. */
export const TransferPanels: React.FC = () => {
  const {
    uploadProgressStore,
    setUploadProgress,
    setIsUploadProgressInteracting,
    cancelUpload,
    downloadProgressStore,
    cancelDownload,
    dismissDownload,
    setIsDownloadProgressInteracting,
  } = useApp();
  const uploads = useStore(uploadProgressStore);
  const downloads = useStore(downloadProgressStore);

  return (
    <>
      <UploadProgress
        uploads={uploads}
        onDismiss={id => setUploadProgress(prev => prev.filter(item => item.id !== id))}
        onInteractionChange={setIsUploadProgressInteracting}
        onCancel={cancelUpload}
      />
      <DownloadProgress
        downloads={downloads}
        onDismiss={dismissDownload}
        onInteractionChange={setIsDownloadProgressInteracting}
        onCancel={cancelDownload}
      />
    </>
  );
};
