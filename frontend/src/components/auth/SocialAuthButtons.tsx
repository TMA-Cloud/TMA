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
        className="btn btn-secondary w-full !py-2.5"
      >
        Continue with Google
      </button>
    </div>
  );
};
