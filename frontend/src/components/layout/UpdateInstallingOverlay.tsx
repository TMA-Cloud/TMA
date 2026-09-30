import React from 'react';
import { useApp } from '../../contexts/AppContext';

/**
 * Shown once the desktop update is downloaded and the silent installer has
 * started. The app quits a few seconds later, so this is the last thing the
 * user sees before the new version opens; it blocks input so nothing is
 * started that the quit would cut off.
 */
export const UpdateInstallingOverlay: React.FC = () => {
  const { electronAutoUpdateState, updatesAvailable } = useApp();
  if (electronAutoUpdateState.status !== 'installing') return null;

  const version = updatesAvailable?.electron?.replace(/^v/i, '');

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[var(--scrim)] animate-fadeIn"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="update-installing-title"
      aria-describedby="update-installing-body"
    >
      <div className="material-thick material-edge rounded-3xl w-[min(22rem,calc(100vw-2rem))] px-6 py-7 text-center text-[var(--label)]">
        <img src="/tma-192.png" alt="" className="w-14 h-14 mx-auto mb-4 rounded-2xl" />
        <h2 id="update-installing-title" className="type-title-3 vibrant mb-1.5">
          Updating TMA Cloud{version ? ` to ${version}` : ''}
        </h2>
        <p id="update-installing-body" className="type-footnote text-[var(--label-secondary)] mb-5">
          TMA Cloud will close and reopen when the update is done. If Windows asks for permission, choose Yes.
        </p>
        <div className="h-1 w-full rounded-full bg-[var(--fill-tertiary)] overflow-hidden" aria-hidden="true">
          <div className="h-full w-1/3 rounded-full bg-[var(--accent)] animate-indeterminate" />
        </div>
      </div>
    </div>
  );
};
