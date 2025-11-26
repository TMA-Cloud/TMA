import React from "react";

interface SocialAuthButtonsProps {
  googleEnabled: boolean;
}

export const SocialAuthButtons: React.FC<SocialAuthButtonsProps> = ({
  googleEnabled,
}) => {
  return (
    <div className="flex flex-col gap-2 mt-2 items-center">
      <button
        type="button"
        onClick={() => {
          window.location.href = `/api/google/login`;
        }}
        disabled={!googleEnabled}
        className="flex items-center justify-center gap-2 w-full px-4 py-2 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl text-gray-700 dark:text-gray-300 font-medium hover:bg-gray-200 dark:hover:bg-gray-700 transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Continue with Google
      </button>
    </div>
  );
};
