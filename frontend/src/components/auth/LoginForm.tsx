import React, { useState, useEffect } from 'react';
import { HardDrive } from 'lucide-react';
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
    let cancelled = false;
    checkGoogleAuthEnabled()
      .then(enabled => {
        if (!cancelled) setGoogleEnabled(enabled);
      })
      .catch(() => {
        if (!cancelled) setGoogleEnabled(false);
      });
    return () => {
      cancelled = true;
    };
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
    <div className="material-thick material-edge rounded-3xl p-8 w-96 max-w-[calc(100vw-2rem)] animate-modalIn">
      {/* Says where you are before it asks you for anything. */}
      <div className="flex flex-col items-center gap-3 mb-7">
        <div className="w-11 h-11 bg-[var(--accent)] rounded-[14px] grid place-items-center">
          <HardDrive className="w-5 h-5 text-[var(--label-on-accent)]" strokeWidth={2.25} />
        </div>
        <div className="text-center">
          <h1 className="type-title-2 text-[var(--label)]">Sign in to CloudStore</h1>
          <p className="type-footnote text-[var(--label-tertiary)] mt-1">Your files, wherever you are</p>
        </div>
      </div>

      <form className="space-y-3" onSubmit={handleSubmit}>
        <input
          className="field"
          placeholder="Email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          autoComplete="email"
          maxLength={254}
          autoFocus
        />
        <PasswordInput
          value={password}
          onChange={e => setPassword(e.target.value)}
          maxLength={128}
          showPassword={showPassword}
          onTogglePassword={() => setShowPassword(v => !v)}
        />
        {requiresMfa && (
          <div className="pt-1">
            <label className="type-caption type-emphasized text-[var(--label-secondary)] block mb-1.5">MFA code</label>
            <input
              type="text"
              maxLength={9}
              value={mfaCode}
              onChange={e => {
                const value = e.target.value.toUpperCase();
                const filtered = value.replace(/[^A-Z0-9-]/g, '');
                setMfaCode(filtered.replace(/-/g, ''));
              }}
              className="field text-center text-xl tracking-[0.35em] font-mono uppercase"
              placeholder="000000"
              autoFocus
            />
            <p className="type-caption text-[var(--label-tertiary)] mt-2">
              The 6-digit code from your authenticator app, or an 8-character backup code
            </p>
          </div>
        )}
        {/* Validation lands beside the fields it is about, rather than on a
            banner somewhere else on the screen. */}
        {error && (
          <p
            className="type-footnote type-emphasized text-[var(--destructive-text)] animate-slideDown"
            key={error}
            role="alert"
          >
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary w-full !py-2.5 mt-1">
          Sign in
        </button>
        <SocialAuthButtons googleEnabled={googleEnabled} />
        {signupEnabled && (
          <p className="type-footnote text-center text-[var(--label-tertiary)] pt-1">
            No account?{' '}
            <button
              type="button"
              onClick={onSwitch}
              className="type-emphasized text-[var(--accent)] hover:underline underline-offset-2"
            >
              Create one
            </button>
          </p>
        )}
      </form>
    </div>
  );
};
