import React from 'react';
import { ClipboardPaste } from 'lucide-react';
import { FixedProgress } from './FixedProgress';

interface PasteProgressProps {
  progress: number | null;
}

export const PasteProgress: React.FC<PasteProgressProps> = ({ progress }) => {
  if (progress === null) return null;

  return <FixedProgress icon={ClipboardPaste} title="Pasting files..." percent={progress} variant="blue-pulse" />;
};
