import React, { useState, useEffect, useRef } from 'react';
import { HardDrive } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { PasswordInput } from './PasswordInput';
import { SocialAuthButtons } from './SocialAuthButtons';
import { checkGoogleAuthEnabled } from '../../utils/api';
import {
  MAX_EMAIL_LENGTH,
  MAX_PASSWORD_LENGTH,
  validateEmail,
  validateLoginPassword,
  validateMfaCode,
} from '../../utils/authValidation';

type FieldErrors = {
  email?: string;
  password?: string;
  mfaCode?: string;
};

export const LoginForm: React.FC<{
  onSwitch: () => void;
  signupEnabled: boolean;
}> = ({ onSwitch, signupEnabled }) => {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [requiresMfa, setRequiresMfa] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const mfaRef = useRef<HTMLInputElement>(null);

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

  // Clearing a field's error as soon as it is edited keeps a stale complaint
  // from sitting under a box the user has already fixed.
  const clearFieldError = (field: keyof FieldErrors) => {
    setFieldErrors(prev => (prev[field] ? { ...prev, [field]: undefined } : prev));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError('');

    // Check every field before deciding.
    const errors: FieldErrors = {
      email: validateEmail(email) ?? undefined,
      password: validateLoginPassword(password) ?? undefined,
      mfaCode: requiresMfa ? (validateMfaCode(mfaCode) ?? undefined) : undefined,
    };
    setFieldErrors(errors);

    // Focus goes to the first field that needs attention.
    const firstInvalid = (
      [
        [errors.email, emailRef],
        [errors.password, passwordRef],
        [errors.mfaCode, mfaRef],
      ] as const
    ).find(([message]) => message);
    if (firstInvalid) {
      firstInvalid[1].current?.focus();
      return;
    }

    setSubmitting(true);
    try {
      const result = await login(email.trim(), password, requiresMfa ? mfaCode : undefined);

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
    } finally {
      setSubmitting(false);
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

      {/* noValidate hands validation to the code below, so every message on
          this form looks and reads the same. */}
      <form className="space-y-3" onSubmit={handleSubmit} noValidate>
        <div>
          <input
            ref={emailRef}
            id="login-email"
            type="email"
            className="field"
            placeholder="Email"
            aria-label="Email"
            value={email}
            onChange={e => {
              setEmail(e.target.value);
              clearFieldError('email');
            }}
            autoComplete="email"
            maxLength={MAX_EMAIL_LENGTH}
            required
            aria-invalid={fieldErrors.email ? true : undefined}
            aria-describedby={fieldErrors.email ? 'login-email-error' : undefined}
            autoFocus
          />
          {fieldErrors.email && (
            <p
              id="login-email-error"
              className="type-caption text-[var(--destructive-text)] mt-1.5 animate-slideDown"
              role="alert"
            >
              {fieldErrors.email}
            </p>
          )}
        </div>
        <div>
          <PasswordInput
            inputRef={passwordRef}
            id="login-password"
            value={password}
            onChange={e => {
              setPassword(e.target.value);
              clearFieldError('password');
            }}
            maxLength={MAX_PASSWORD_LENGTH}
            showPassword={showPassword}
            onTogglePassword={() => setShowPassword(v => !v)}
            invalid={Boolean(fieldErrors.password)}
            describedBy={fieldErrors.password ? 'login-password-error' : undefined}
          />
          {fieldErrors.password && (
            <p
              id="login-password-error"
              className="type-caption text-[var(--destructive-text)] mt-1.5 animate-slideDown"
              role="alert"
            >
              {fieldErrors.password}
            </p>
          )}
        </div>
        {requiresMfa && (
          <div className="pt-1">
            <label
              htmlFor="login-mfa"
              className="type-caption type-emphasized text-[var(--label-secondary)] block mb-1.5"
            >
              MFA code
            </label>
            <input
              ref={mfaRef}
              id="login-mfa"
              type="text"
              maxLength={9}
              value={mfaCode}
              onChange={e => {
                const value = e.target.value.toUpperCase();
                const filtered = value.replace(/[^A-Z0-9-]/g, '');
                setMfaCode(filtered.replace(/-/g, ''));
                clearFieldError('mfaCode');
              }}
              className="field text-center text-xl tracking-[0.35em] font-mono uppercase"
              placeholder="000000"
              required
              aria-invalid={fieldErrors.mfaCode ? true : undefined}
              aria-describedby={`login-mfa-hint${fieldErrors.mfaCode ? ' login-mfa-error' : ''}`}
              autoFocus
            />
            {fieldErrors.mfaCode && (
              <p
                id="login-mfa-error"
                className="type-caption text-[var(--destructive-text)] mt-1.5 animate-slideDown"
                role="alert"
              >
                {fieldErrors.mfaCode}
              </p>
            )}
            <p id="login-mfa-hint" className="type-caption text-[var(--label-tertiary)] mt-2">
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
        {/* Disabled only while a request is in flight — a button greyed out
            because a field is empty gives no reason why. */}
        <button type="submit" className="btn btn-primary w-full !py-2.5 mt-1" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Sign in'}
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
