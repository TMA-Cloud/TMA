import React from "react";
import { Eye, EyeOff } from "lucide-react";

interface PasswordInputProps {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  autoComplete?: string;
  maxLength?: number;
  showPassword: boolean;
  onTogglePassword: () => void;
}

export const PasswordInput: React.FC<PasswordInputProps> = ({
  value,
  onChange,
  placeholder = "Password",
  autoComplete = "current-password",
  maxLength = 128,
  showPassword,
  onTogglePassword,
}) => {
  return (
    <div className="relative">
      <input
        className="border border-gray-300 dark:border-gray-600 rounded-xl px-4 py-3 w-full bg-gray-50/80 dark:bg-gray-800/80 focus:outline-none focus:ring-2 focus:ring-blue-500 shadow-sm transition-all duration-200 text-base pr-12"
        type={showPassword ? "text" : "password"}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        autoComplete={autoComplete}
        maxLength={maxLength}
      />
      <button
        type="button"
        className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-blue-500 focus:outline-none"
        tabIndex={-1}
        onClick={onTogglePassword}
        aria-label={showPassword ? "Hide password" : "Show password"}
      >
        {showPassword ? (
          <EyeOff className="w-5 h-5" />
        ) : (
          <Eye className="w-5 h-5" />
        )}
      </button>
    </div>
  );
};
