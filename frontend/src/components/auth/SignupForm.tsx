import React, { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { PasswordInput } from './PasswordInput';
import { SocialAuthButtons } from './SocialAuthButtons';
import { checkGoogleAuthEnabled } from '../../utils/api';
import { getErrorMessage } from '../../utils/errorUtils';

export const SignupForm: React.FC<{ onSwitch: () => void }> = ({ onSwitch }) => {
  const { signup } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);

  useEffect(() => {
    checkGoogleAuthEnabled()
      .then(setGoogleEnabled)
      .catch(() => {
        // Error handled silently - Google auth will be unavailable
        // Default to false on error
        setGoogleEnabled(false);
      });
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await signup(email, password, name);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to sign up'));
    }
  };

  return (
    <div className="bg-[#f0f3f7]/95 dark:bg-slate-800/95 backdrop-blur-xl rounded-3xl p-8 border border-slate-200/60 dark:border-slate-700/50 w-96 max-w-[calc(100vw-2rem)] shadow-soft-lg">
      <form className="space-y-5" onSubmit={handleSubmit}>
        <div>
          <input
            className="border border-slate-200/80 dark:border-slate-600/80 rounded-2xl px-4 py-3 w-full bg-white/70 dark:bg-slate-700/50 focus:outline-none focus:ring-2 focus:ring-[#5b8def]/35 focus:border-[#5b8def]/40 text-slate-800 dark:text-slate-100 placeholder-slate-400 transition-all duration-300 ease-out text-base"
            placeholder="Name"
            value={name}
            onChange={e => setName(e.target.value)}
            autoComplete="name"
            maxLength={100}
          />
        </div>
        <div>
          <input
            className="border border-slate-200/80 dark:border-slate-600/80 rounded-2xl px-4 py-3 w-full bg-white/70 dark:bg-slate-700/50 focus:outline-none focus:ring-2 focus:ring-[#5b8def]/35 focus:border-[#5b8def]/40 text-slate-800 dark:text-slate-100 placeholder-slate-400 transition-all duration-300 ease-out text-base"
            placeholder="Email"
            value={email}
            onChange={e => setEmail(e.target.value)}
            autoComplete="email"
            maxLength={254}
            autoFocus
          />
        </div>
        <PasswordInput
          value={password}
          onChange={e => setPassword(e.target.value)}
          autoComplete="new-password"
          maxLength={128}
          showPassword={showPassword}
          onTogglePassword={() => setShowPassword(v => !v)}
        />
        {error && (
          <p className="text-red-500 text-sm font-medium animate-bounceIn" key={error}>
            {error}
          </p>
        )}
        <button
          type="submit"
          className="w-full bg-gradient-to-r from-[#5b8def] to-[#4a7edb] hover:from-[#4a7edb] hover:to-[#3d6ec7] text-white px-4 py-3 rounded-2xl shadow-soft transition-all duration-300 ease-out text-base font-semibold"
        >
          Sign Up
        </button>
        <SocialAuthButtons googleEnabled={googleEnabled} />
        <p className="text-sm text-center text-slate-500 dark:text-slate-400">
          Already have an account?{' '}
          <button
            type="button"
            onClick={onSwitch}
            className="underline text-[#5b8def] hover:text-[#4a7edb] font-medium transition-colors duration-300"
          >
            Login
          </button>
        </p>
      </form>
    </div>
  );
};
