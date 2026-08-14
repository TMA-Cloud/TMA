import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/api', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/api')>('../../src/utils/api');
  return {
    ...actual,
    checkAuthSilently: vi.fn(async () => ({ status: 'unauthenticated' as const })),
    setAuthState: vi.fn(),
  };
});

import { AuthProvider } from '../../src/contexts/AuthProvider';
import { useAuth } from '../../src/contexts/AuthContext';
import { ThemeProvider } from '../../src/contexts/ThemeProvider';
import { useTheme } from '../../src/contexts/ThemeContext';

/**
 * Both of these wrap the whole app, so a value rebuilt on every render reaches
 * every consumer below. That is what had a toast reloading the settings pane
 * behind it and wiping a half-typed field: the provider itself looked fine,
 * and the damage showed up somewhere else entirely.
 *
 * Nothing currently keys an effect on these two, so this is the guard rather
 * than the repair — the failure only appears once someone downstream does.
 */
afterEach(() => {
  localStorage.clear();
});

/** Collects the context value seen on every render of a consumer. */
function makeSpy<T>(useValue: () => T) {
  const seen: T[] = [];
  const Spy: React.FC = () => {
    seen.push(useValue());
    return null;
  };
  return { seen, Spy };
}

describe('ThemeProvider', () => {
  it('keeps one context value across re-renders that change nothing', () => {
    const { seen, Spy } = makeSpy(useTheme);
    // A fresh element each time on purpose. Re-rendering the *same* element
    // makes React bail out before the provider body runs, so the value is
    // never rebuilt and the test would pass with or without the memo.
    const tree = () => (
      <ThemeProvider>
        <Spy />
      </ThemeProvider>
    );

    const { rerender } = render(tree());
    rerender(tree());
    rerender(tree());

    // Not re-rendering at all is the ideal outcome, not a hole in the test: a
    // stable value means React can skip the consumer entirely. Dropping the
    // memo shows up here as extra renders carrying a different object.
    expect(new Set(seen).size, `the theme context value changed across ${seen.length} renders`).toBe(1);
  });

  it('gives a new value when the theme actually changes', async () => {
    const seen: string[] = [];
    const Toggle: React.FC = () => {
      const { theme, toggleTheme } = useTheme();
      seen.push(theme);
      return <button onClick={toggleTheme}>flip</button>;
    };

    render(
      <ThemeProvider>
        <Toggle />
      </ThemeProvider>
    );

    const before = seen[seen.length - 1];
    await userEvent.click(screen.getByRole('button', { name: 'flip' }));
    await waitFor(() => expect(seen[seen.length - 1]).not.toBe(before));
  });
});

describe('AuthProvider', () => {
  it('keeps one context value across re-renders that change nothing', async () => {
    const { seen, Spy } = makeSpy(useAuth);
    // Fresh elements, for the same reason as above: re-rendering an identical
    // element never reaches the provider body.
    const tree = () => (
      <AuthProvider>
        <Spy />
      </AuthProvider>
    );

    const { rerender } = render(tree());
    // Let the mount-time session check settle, so the loading flag is not
    // still moving underneath the comparison.
    await waitFor(() => expect(seen[seen.length - 1]!.loading).toBe(false));

    const settled = seen.length;
    await act(async () => {
      rerender(tree());
      rerender(tree());
    });

    const afterSettle = seen.slice(settled - 1);
    expect(
      new Set(afterSettle).size,
      `the auth context value changed across ${afterSettle.length} renders without the session changing`
    ).toBe(1);
  });

  it('keeps its actions stable so nothing downstream re-runs on them', async () => {
    const { seen, Spy } = makeSpy(useAuth);

    render(
      <AuthProvider>
        <Spy />
      </AuthProvider>
    );
    await waitFor(() => expect(seen[seen.length - 1]!.loading).toBe(false));

    const first = seen[0]!;
    const last = seen[seen.length - 1]!;
    // These span the loading -> loaded transition, where the value legitimately
    // changes. The actions on it must not.
    expect(last.login, 'login changed identity').toBe(first.login);
    expect(last.signup, 'signup changed identity').toBe(first.signup);
    expect(last.logout, 'logout changed identity').toBe(first.logout);
  });
});
