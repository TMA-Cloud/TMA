import React from 'react';
import { useApp } from '../../contexts/AppContext';
import { useIsMobile } from '../../hooks/useIsMobile';
import { DesktopImageViewer } from './DesktopImageViewer';
import { MobileImageViewer } from './MobileImageViewer';

export const ImageViewerModal: React.FC = () => {
  const { imageViewerFile, setImageViewerFile, files } = useApp();
  const isMobile = useIsMobile();

  const handleClose = () => setImageViewerFile(null);

  if (!imageViewerFile) return null;

  if (isMobile) {
    return (
      <MobileImageViewer
        imageViewerFile={imageViewerFile}
        onClose={handleClose}
        files={files}
        setImageViewerFile={setImageViewerFile}
      />
    );
  }

  return <DesktopImageViewer imageViewerFile={imageViewerFile} onClose={handleClose} />;
};
