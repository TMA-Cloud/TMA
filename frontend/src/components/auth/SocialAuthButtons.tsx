import React from 'react';

interface SocialAuthButtonsProps {
  googleEnabled: boolean;
}

export const SocialAuthButtons: React.FC<SocialAuthButtonsProps> = ({ googleEnabled }) => {
  return (
    <div className="flex flex-col gap-2 mt-2 items-center">
      <button
        type="button"
        onClick={() => {
          // Set flag to indicate OAuth flow initiated
          // This helps checkAuthSilently know to make API call after OAuth callback
          try {
            sessionStorage.setItem('oauth_initiated', 'true');
          } catch {
            // Ignore sessionStorage errors (e.g., private browsing)
          }
          window.location.href = `/api/google/login`;
        }}
        disabled={!googleEnabled}
        className="flex items-center justify-center gap-2 w-full px-4 py-2.5 bg-white/70 dark:bg-slate-700/50 border border-slate-200/80 dark:border-slate-600/80 rounded-2xl text-slate-700 dark:text-slate-300 font-medium hover:bg-slate-100/80 dark:hover:bg-slate-600/50 transition-all duration-300 ease-out disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Continue with Google
      </button>
    </div>
  );
};
