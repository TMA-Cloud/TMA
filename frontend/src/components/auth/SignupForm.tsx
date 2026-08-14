import React, { useState, useEffect } from 'react';
import { HardDrive } from 'lucide-react';
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
    if (!name.trim()) {
      setError('Please enter your name');
      return;
    }
    if (!email.trim()) {
      setError('Please enter your email');
      return;
    }
    if (password.length < 8) {
      setError('Password must be at least 8 characters long');
      return;
    }
    try {
      await signup(email, password, name);
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to sign up'));
    }
  };

  return (
    <div className="material-thick material-edge rounded-3xl p-8 w-96 max-w-[calc(100vw-2rem)] animate-modalIn">
      <div className="flex flex-col items-center gap-3 mb-7">
        <div className="w-11 h-11 bg-[var(--accent)] rounded-[14px] grid place-items-center">
          <HardDrive className="w-5 h-5 text-[var(--label-on-accent)]" strokeWidth={2.25} />
        </div>
        <div className="text-center">
          <h1 className="type-title-2 text-[var(--label)]">Create your account</h1>
          <p className="type-footnote text-[var(--label-tertiary)] mt-1">It takes about a minute</p>
        </div>
      </div>

      <form className="space-y-3" onSubmit={handleSubmit}>
        <input
          className="field"
          placeholder="Name"
          value={name}
          onChange={e => setName(e.target.value)}
          autoComplete="name"
          maxLength={100}
          autoFocus
        />
        <input
          className="field"
          placeholder="Email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          autoComplete="email"
          maxLength={254}
        />
        <PasswordInput
          value={password}
          onChange={e => setPassword(e.target.value)}
          autoComplete="new-password"
          maxLength={128}
          showPassword={showPassword}
          onTogglePassword={() => setShowPassword(v => !v)}
        />
        {/* The rule is stated up front rather than sprung on submit. */}
        <p className="type-caption text-[var(--label-tertiary)]">At least 8 characters</p>
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
          Create account
        </button>
        <SocialAuthButtons googleEnabled={googleEnabled} />
        <p className="type-footnote text-center text-[var(--label-tertiary)] pt-1">
          Already have an account?{' '}
          <button
            type="button"
            onClick={onSwitch}
            className="type-emphasized text-[var(--accent)] hover:underline underline-offset-2"
          >
            Sign in
          </button>
        </p>
      </form>
    </div>
  );
};
