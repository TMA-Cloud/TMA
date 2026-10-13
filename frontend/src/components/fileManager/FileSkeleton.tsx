import React from 'react';

interface FileSkeletonProps {
  viewMode: 'grid' | 'list';
  count?: number;
}

// Uneven name widths read as a real listing; identical bars read as a broken page.
const NAME_WIDTHS = ['w-40', 'w-56', 'w-32', 'w-48', 'w-64', 'w-36', 'w-52', 'w-44'];
const CARD_NAME_WIDTHS = ['w-24', 'w-16', 'w-20', 'w-28', 'w-14', 'w-24'];

/** Placeholder rows shaped like FileItem, so the real listing lands without the layout shifting. */
export const FileSkeleton: React.FC<FileSkeletonProps> = ({ viewMode, count = 12 }) => {
  const items = Array.from({ length: count }, (_, index) => index);

  if (viewMode === 'grid') {
    return (
      <div
        className="grid w-full gap-3"
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(min(150px, 100%), 1fr))' }}
        aria-hidden="true"
      >
        {items.map(index => (
          <div key={index} className="rounded-2xl border border-[var(--separator)] bg-[var(--surface)] p-3">
            <div className="flex flex-col items-center gap-1.5">
              <div className="mb-1.5 h-11 w-11 skeleton" />
              <div className={`h-3.5 ${CARD_NAME_WIDTHS[index % CARD_NAME_WIDTHS.length]} skeleton`} />
              <div className="h-3 w-12 skeleton" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="w-full" aria-hidden="true">
      {items.map(index => (
        <div key={index} className="pb-1">
          <div className="flex items-center gap-3 rounded-xl px-3 py-2">
            <div className="h-9 w-9 flex-shrink-0 skeleton" />
            <div className="flex-1 space-y-1.5">
              <div className={`h-4 max-w-full ${NAME_WIDTHS[index % NAME_WIDTHS.length]} skeleton`} />
              <div className="h-3 w-20 skeleton" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};
