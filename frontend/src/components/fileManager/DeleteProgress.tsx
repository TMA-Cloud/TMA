import React from 'react';
import { Trash2 } from 'lucide-react';
import { FixedProgress } from './FixedProgress';

interface DeleteProgressProps {
  progress: {
    itemCount: number;
    percent: number;
    label: string;
  } | null;
}

export const DeleteProgress: React.FC<DeleteProgressProps> = ({ progress }) => {
  if (!progress) return null;

  return (
    <FixedProgress
      icon={Trash2}
      title={progress.label}
      subtitle={`${progress.itemCount} item${progress.itemCount !== 1 ? 's' : ''} selected`}
      percent={progress.percent}
      showPercentBadge
      variant="neutral"
    />
  );
};
