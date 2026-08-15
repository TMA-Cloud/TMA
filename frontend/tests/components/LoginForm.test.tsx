import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { LoginForm } from '../../src/components/auth/LoginForm';
import {
  MIN_PASSWORD_LENGTH,
  validateEmail,
  validateLoginPassword,
  validateMfaCode,
  validateNewPassword,
} from '../../src/utils/authValidation';

const login = vi.fn();

vi.mock('../../src/contexts/AuthContext', () => ({
  useAuth: () => ({ login }),
}));

vi.mock('../../src/utils/api', () => ({
  checkGoogleAuthEnabled: () => Promise.resolve(false),
}));

/**
 * The bug these cover: an empty form used to submit, so the server answered
 * 422 and the user was told "Validation failed" for a box they could see was
 * blank. Nothing should leave the page until the fields are filled in.
 */
describe('LoginForm validation', () => {
  beforeEach(() => {
    login.mockReset();
    login.mockResolvedValue({ success: true });
  });

  it('does not call the API when both fields are empty', async () => {
    const user = userEvent.setup();
    render(<LoginForm onSwitch={() => {}} signupEnabled={false} />);

    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(login).not.toHaveBeenCalled();
    expect(screen.getByText('Enter your email address')).toBeInTheDocument();
    expect(screen.getByText('Enter your password')).toBeInTheDocument();
  });

  it('reports every empty field at once and focuses the first one', async () => {
    const user = userEvent.setup();
    render(<LoginForm onSwitch={() => {}} signupEnabled={false} />);
    const email = screen.getByLabelText('Email');

    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(email).toHaveFocus();
    expect(email).toHaveAttribute('aria-invalid', 'true');
    expect(email).toHaveAttribute('aria-describedby', 'login-email-error');
  });

  it('rejects an address that is not an email before hitting the network', async () => {
    const user = userEvent.setup();
    render(<LoginForm onSwitch={() => {}} signupEnabled={false} />);

    await user.type(screen.getByLabelText('Email'), 'not-an-email');
    await user.type(screen.getByLabelText('Password'), 'hunter22');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(login).not.toHaveBeenCalled();
    expect(screen.getByText(/valid email address/)).toBeInTheDocument();
  });

  it('clears a field error as soon as that field is edited', async () => {
    const user = userEvent.setup();
    render(<LoginForm onSwitch={() => {}} signupEnabled={false} />);

    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByText('Enter your email address')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Email'), 'a');
    expect(screen.queryByText('Enter your email address')).not.toBeInTheDocument();
  });

  it('submits a filled form with the email trimmed', async () => {
    const user = userEvent.setup();
    render(<LoginForm onSwitch={() => {}} signupEnabled={false} />);

    await user.type(screen.getByLabelText('Email'), '  me@example.com  ');
    await user.type(screen.getByLabelText('Password'), 'hunter22');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(login).toHaveBeenCalledWith('me@example.com', 'hunter22', undefined));
  });

  it('does not fire a second request while one is in flight', async () => {
    const user = userEvent.setup();
    let release: (value: { success: boolean }) => void = () => {};
    login.mockReturnValue(new Promise(resolve => (release = resolve)));
    render(<LoginForm onSwitch={() => {}} signupEnabled={false} />);

    await user.type(screen.getByLabelText('Email'), 'me@example.com');
    await user.type(screen.getByLabelText('Password'), 'hunter22');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(login).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled();
    release({ success: true });
  });
});

describe('auth validation rules', () => {
  it('accepts ordinary addresses and rejects the common mistakes', () => {
    expect(validateEmail('me@example.com')).toBeNull();
    expect(validateEmail('me+tag@sub.example.co.uk')).toBeNull();
    expect(validateEmail('')).toBe('Enter your email address');
    expect(validateEmail('   ')).toBe('Enter your email address');
    expect(validateEmail('me')).not.toBeNull();
    expect(validateEmail('me@example')).not.toBeNull();
    expect(validateEmail(`${'a'.repeat(250)}@example.com`)).toMatch(/254/);
  });

  it('asks sign-in only for a password that exists', () => {
    expect(validateLoginPassword('x')).toBeNull();
    expect(validateLoginPassword('')).toBe('Enter your password');
    expect(validateLoginPassword('x'.repeat(129))).toMatch(/128/);
  });

  /**
   * The two ends used to disagree — the form asked for 8 while the schema let
   * 6 through, so the copy on screen was simply wrong. If someone lowers one
   * side, this fails rather than the mismatch reappearing silently.
   */
  it('holds a new password to the same floor the server enforces', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(8);
    expect(validateNewPassword('a'.repeat(MIN_PASSWORD_LENGTH))).toBeNull();
    expect(validateNewPassword('a'.repeat(MIN_PASSWORD_LENGTH - 1))).toBe('Password must be at least 8 characters');
    expect(validateNewPassword('')).toBe('Choose a password');
    expect(validateNewPassword('a'.repeat(129))).toMatch(/128/);
  });

  it('takes a 6-digit code or an 8-character backup code', () => {
    expect(validateMfaCode('123456')).toBeNull();
    expect(validateMfaCode('ABCD1234')).toBeNull();
    expect(validateMfaCode('')).toBe('Enter your MFA code');
    expect(validateMfaCode('123')).not.toBeNull();
  });
});
