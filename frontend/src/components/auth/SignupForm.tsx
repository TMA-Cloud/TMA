import React, { useState, useEffect, useRef } from 'react';
import { HardDrive } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { PasswordInput } from './PasswordInput';
import { SocialAuthButtons } from './SocialAuthButtons';
import { checkGoogleAuthEnabled } from '../../utils/api';
import { getErrorMessage } from '../../utils/errorUtils';
import {
  MAX_EMAIL_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  validateEmail,
  validateName,
  validateNewPassword,
} from '../../utils/authValidation';

type FieldErrors = {
  name?: string;
  email?: string;
  password?: string;
};

export const SignupForm: React.FC<{ onSwitch: () => void }> = ({ onSwitch }) => {
  const { signup } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

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

  const clearFieldError = (field: keyof FieldErrors) => {
    setFieldErrors(prev => (prev[field] ? { ...prev, [field]: undefined } : prev));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError('');

    // Every field is checked in one pass, so the form asks for all its
    // corrections at once.
    const errors: FieldErrors = {
      name: validateName(name) ?? undefined,
      email: validateEmail(email) ?? undefined,
      password: validateNewPassword(password) ?? undefined,
    };
    setFieldErrors(errors);

    const firstInvalid = (
      [
        [errors.name, nameRef],
        [errors.email, emailRef],
        [errors.password, passwordRef],
      ] as const
    ).find(([message]) => message);
    if (firstInvalid) {
      firstInvalid[1].current?.focus();
      return;
    }

    setSubmitting(true);
    try {
      await signup(email.trim(), password, name.trim());
    } catch (err) {
      setError(getErrorMessage(err, 'Failed to sign up'));
    } finally {
      setSubmitting(false);
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

      {/* noValidate keeps every message on this form in one voice instead of
          letting the browser answer for some fields in its own wording. */}
      <form className="space-y-3" onSubmit={handleSubmit} noValidate>
        <div>
          <input
            ref={nameRef}
            id="signup-name"
            className="field"
            placeholder="Name"
            aria-label="Name"
            value={name}
            onChange={e => {
              setName(e.target.value);
              clearFieldError('name');
            }}
            autoComplete="name"
            maxLength={MAX_NAME_LENGTH}
            required
            aria-invalid={fieldErrors.name ? true : undefined}
            aria-describedby={fieldErrors.name ? 'signup-name-error' : undefined}
            autoFocus
          />
          {fieldErrors.name && (
            <p
              id="signup-name-error"
              className="type-caption text-[var(--destructive-text)] mt-1.5 animate-slideDown"
              role="alert"
            >
              {fieldErrors.name}
            </p>
          )}
        </div>
        <div>
          <input
            ref={emailRef}
            id="signup-email"
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
            aria-describedby={fieldErrors.email ? 'signup-email-error' : undefined}
          />
          {fieldErrors.email && (
            <p
              id="signup-email-error"
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
            id="signup-password"
            value={password}
            onChange={e => {
              setPassword(e.target.value);
              clearFieldError('password');
            }}
            autoComplete="new-password"
            maxLength={MAX_PASSWORD_LENGTH}
            showPassword={showPassword}
            onTogglePassword={() => setShowPassword(v => !v)}
            invalid={Boolean(fieldErrors.password)}
            describedBy={`signup-password-hint${fieldErrors.password ? ' signup-password-error' : ''}`}
          />
          {fieldErrors.password && (
            <p
              id="signup-password-error"
              className="type-caption text-[var(--destructive-text)] mt-1.5 animate-slideDown"
              role="alert"
            >
              {fieldErrors.password}
            </p>
          )}
        </div>
        {/* The rule is stated up front rather than sprung on submit. */}
        <p id="signup-password-hint" className="type-caption text-[var(--label-tertiary)]">
          At least {MIN_PASSWORD_LENGTH} characters
        </p>
        {error && (
          <p
            className="type-footnote type-emphasized text-[var(--destructive-text)] animate-slideDown"
            key={error}
            role="alert"
          >
            {error}
          </p>
        )}
        <button type="submit" className="btn btn-primary w-full !py-2.5 mt-1" disabled={submitting}>
          {submitting ? 'Creating account…' : 'Create account'}
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
