import React from 'react';
import { RotateCcw } from 'lucide-react';
import { FixedProgress } from './FixedProgress';

interface RestoreProgressProps {
  progress: {
    itemCount: number;
    percent: number;
    label: string;
  } | null;
}

export const RestoreProgress: React.FC<RestoreProgressProps> = ({ progress }) => {
  if (!progress) return null;

  return (
    <FixedProgress
      icon={RotateCcw}
      title={progress.label}
      subtitle={`${progress.itemCount} item${progress.itemCount !== 1 ? 's' : ''} selected`}
      percent={progress.percent}
      showPercentBadge
      variant="emerald"
    />
  );
};
