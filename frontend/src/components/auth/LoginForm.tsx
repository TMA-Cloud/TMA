import React, { useState, useEffect } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { PasswordInput } from './PasswordInput';
import { SocialAuthButtons } from './SocialAuthButtons';
import { checkGoogleAuthEnabled } from '../../utils/api';

export const LoginForm: React.FC<{
  onSwitch: () => void;
  signupEnabled: boolean;
}> = ({ onSwitch, signupEnabled }) => {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [requiresMfa, setRequiresMfa] = useState(false);
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

    if (requiresMfa && !mfaCode) {
      setError('Please enter your MFA code');
      return;
    }

    const result = await login(email, password, requiresMfa ? mfaCode : undefined);

    if (result.success) {
      // Login successful
      return;
    }

    if (result.requiresMfa) {
      setRequiresMfa(true);
      setError(result.message || 'MFA code required');
    } else {
      setError(result.message || 'Invalid credentials');
      setRequiresMfa(false);
      setMfaCode('');
    }
  };

  return (
    <div className="bg-[#f0f3f7]/95 dark:bg-slate-800/95 backdrop-blur-xl rounded-3xl p-8 border border-slate-200/60 dark:border-slate-700/50 w-96 max-w-[calc(100vw-2rem)] shadow-soft-lg">
      <form className="space-y-5" onSubmit={handleSubmit}>
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
          maxLength={128}
          showPassword={showPassword}
          onTogglePassword={() => setShowPassword(v => !v)}
        />
        {requiresMfa && (
          <div>
            <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">MFA Code</label>
            <input
              type="text"
              maxLength={9}
              value={mfaCode}
              onChange={e => {
                const value = e.target.value.toUpperCase();
                const filtered = value.replace(/[^A-Z0-9-]/g, '');
                setMfaCode(filtered.replace(/-/g, ''));
              }}
              className="border border-slate-200/80 dark:border-slate-600/80 rounded-2xl px-4 py-3 w-full bg-white/70 dark:bg-slate-700/50 focus:outline-none focus:ring-2 focus:ring-[#5b8def]/35 text-center text-xl tracking-widest font-mono uppercase text-slate-800 dark:text-slate-100 transition-all duration-300 ease-out"
              placeholder="000000 or ABCD-EFGH"
              autoFocus
            />
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1.5">
              Enter the 6-digit code from your authenticator app or an 8-character backup code
            </p>
          </div>
        )}
        {error && (
          <p className="text-red-500 text-sm font-medium animate-bounceIn" key={error}>
            {error}
          </p>
        )}
        <button
          type="submit"
          className="w-full bg-gradient-to-r from-[#5b8def] to-[#4a7edb] hover:from-[#4a7edb] hover:to-[#3d6ec7] text-white px-4 py-3 rounded-2xl shadow-soft transition-all duration-300 ease-out text-base font-semibold"
        >
          Login
        </button>
        <SocialAuthButtons googleEnabled={googleEnabled} />
        {signupEnabled && (
          <p className="text-sm text-center text-slate-500 dark:text-slate-400">
            No account?{' '}
            <button
              type="button"
              onClick={onSwitch}
              className="underline text-[#5b8def] hover:text-[#4a7edb] font-medium transition-colors duration-300"
            >
              Sign up
            </button>
          </p>
        )}
      </form>
    </div>
  );
};
