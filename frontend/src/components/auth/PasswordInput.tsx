import React from 'react';
import { Eye, EyeOff } from 'lucide-react';

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
  placeholder = 'Password',
  autoComplete = 'current-password',
  maxLength = 128,
  showPassword,
  onTogglePassword,
}) => {
  return (
    <div className="relative">
      <input
        className="border border-slate-200/80 dark:border-slate-600/80 rounded-2xl px-4 py-3 w-full bg-white/70 dark:bg-slate-700/50 focus:outline-none focus:ring-2 focus:ring-[#5b8def]/35 focus:border-[#5b8def]/40 text-slate-800 dark:text-slate-100 placeholder-slate-400 transition-all duration-300 ease-out text-base pr-12"
        type={showPassword ? 'text' : 'password'}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        autoComplete={autoComplete}
        maxLength={maxLength}
      />
      <button
        type="button"
        className="absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded-xl text-slate-400 hover:text-[#5b8def] dark:hover:text-blue-400 focus:outline-none transition-colors duration-300"
        tabIndex={-1}
        onClick={onTogglePassword}
        aria-label={showPassword ? 'Hide password' : 'Show password'}
      >
        {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
      </button>
    </div>
  );
};
