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
  id?: string;
  invalid?: boolean;
  describedBy?: string;
  inputRef?: React.Ref<HTMLInputElement>;
}

export const PasswordInput: React.FC<PasswordInputProps> = ({
  value,
  onChange,
  placeholder = 'Password',
  autoComplete = 'current-password',
  maxLength = 128,
  showPassword,
  onTogglePassword,
  id,
  invalid,
  describedBy,
  inputRef,
}) => {
  return (
    <div className="relative">
      <input
        ref={inputRef}
        id={id}
        className="field pr-11"
        type={showPassword ? 'text' : 'password'}
        placeholder={placeholder}
        aria-label={placeholder}
        value={value}
        onChange={onChange}
        autoComplete={autoComplete}
        maxLength={maxLength}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
      />
      <button
        type="button"
        className="pressable absolute right-2 top-1/2 -translate-y-1/2 grid place-items-center w-7 h-7 rounded-full text-[var(--label-tertiary)] hover:bg-[var(--fill-tertiary)] hover:text-[var(--label)]"
        tabIndex={-1}
        onClick={onTogglePassword}
        aria-label={showPassword ? 'Hide password' : 'Show password'}
      >
        {showPassword ? <EyeOff className="w-4 h-4" strokeWidth={2} /> : <Eye className="w-4 h-4" strokeWidth={2} />}
      </button>
    </div>
  );
};
