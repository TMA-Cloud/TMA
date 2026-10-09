import React from 'react';
import { TriangleAlert } from 'lucide-react';
import { useApp } from '../../contexts/AppContext';

/**
 * Shown everywhere but Settings while no bucket is connected, since every
 * upload and download fails until one is. Only the first user can act on it,
 * so only they get the button.
 */
export const StorageSetupBanner: React.FC<{ className?: string }> = ({ className = '' }) => {
  const { storageConfigured, canConfigureStorage, currentPath, setCurrentPath } = useApp();
  if (storageConfigured !== false || currentPath[0] === 'Settings') return null;

  return (
    <div
      role="status"
      className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl px-4 py-3 border border-[var(--warning)]/40 bg-[var(--warning)]/10 ${className}`}
    >
      <TriangleAlert className="w-4 h-4 shrink-0 text-[var(--warning-text)]" aria-hidden />
      <p className="type-footnote text-[var(--label)] flex-1 min-w-[12rem]">
        {canConfigureStorage
          ? 'Connect a storage bucket before anyone can upload or open files.'
          : 'Storage is not set up yet, so files cannot be uploaded or opened. Ask your administrator to connect a bucket.'}
      </p>
      {canConfigureStorage && (
        <button
          type="button"
          onClick={() => setCurrentPath(['Settings'])}
          className="pressable type-footnote type-emphasized rounded-full px-3.5 py-1.5 bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--label-on-accent)]"
        >
          Set up storage
        </button>
      )}
    </div>
  );
};
