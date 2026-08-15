import React from 'react';
import { Monitor } from 'lucide-react';
import { ProgressCard } from './FixedProgress';
import { clampPercent } from './progressUtils';

interface DesktopOpenProgressItem {
  fileId: string;
  fileName: string;
  percent: number;
}

interface DesktopOpenProgressProps {
  items: DesktopOpenProgressItem[];
}

export const DesktopOpenProgress: React.FC<DesktopOpenProgressProps> = ({ items }) => {
  if (!items || items.length === 0) return null;

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex flex-col space-y-2">
      {items.map(item => (
        <ProgressCard
          key={item.fileId}
          icon={Monitor}
          title={`Opening file… ${clampPercent(item.percent)}%`}
          subtitle={
            <span className="break-all" title={item.fileName}>
              {item.fileName}
            </span>
          }
          percent={item.percent}
          variant="blue-pulse"
          className="surface-raised"
        />
      ))}
    </div>
  );
};
