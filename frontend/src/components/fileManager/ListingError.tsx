import React from 'react';
import { CloudOff } from 'lucide-react';

interface ListingErrorProps {
  onRetry: () => void;
}

/** A failed listing must not pass for an empty folder, or users think their files are gone. */
export const ListingError: React.FC<ListingErrorProps> = ({ onRetry }) => (
  <div role="alert" className="flex h-64 w-full flex-col items-center justify-center text-center animate-fadeIn">
    <div className="mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-[var(--fill-quaternary)]">
      <CloudOff className="h-6 w-6 text-[var(--label-tertiary)]" />
    </div>
    <h3 className="type-title-3 text-[var(--label)]">Couldn't load this folder</h3>
    <p className="type-footnote mt-1.5 max-w-xs text-[var(--label-tertiary)]">Check your connection and try again</p>
    <button type="button" className="btn btn-secondary mt-4" onClick={onRetry}>
      Try again
    </button>
  </div>
);
