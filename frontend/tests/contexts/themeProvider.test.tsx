import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '../../src/contexts/ThemeProvider';
import { useTheme } from '../../src/contexts/ThemeContext';

/**
 * The desktop client's splash and connection-error screens are data: URLs, so
 * they cannot read the `theme` key this provider writes. They read what the
 * main process was told instead — which is why every switch has to be pushed
 * across the bridge as it happens. Reading it back only at load time left the
 * splash a full launch behind the toggle.
 */

const Toggle: React.FC = () => {
  const { theme, toggleTheme } = useTheme();
  return (
    <button onClick={toggleTheme} data-testid="toggle">
      {theme}
    </button>
  );
};

function renderWithProvider() {
  return render(
    <ThemeProvider>
      <Toggle />
    </ThemeProvider>
  );
}

afterEach(() => {
  localStorage.clear();
  delete (window as { electronAPI?: unknown }).electronAPI;
});

/** Stand in for the preload bridge and hand back the calls it received. */
function stubDesktopBridge(setTheme = vi.fn(async () => ({ ok: true }))) {
  (window as { electronAPI?: unknown }).electronAPI = { app: { setTheme } };
  return setTheme;
}

describe('ThemeProvider', () => {
  it('tells the desktop client which theme it is in on first render', () => {
    const setTheme = stubDesktopBridge();

    renderWithProvider();

    expect(setTheme).toHaveBeenCalledWith('dark');
  });

  it('reports a switch immediately, not on the next launch', async () => {
    const setTheme = stubDesktopBridge();
    renderWithProvider();

    await userEvent.click(screen.getByTestId('toggle'));

    expect(setTheme).toHaveBeenLastCalledWith('light');
    expect(localStorage.getItem('theme')).toBe('light');
  });

  it('renders in the browser, where there is no bridge to report to', async () => {
    renderWithProvider();

    await userEvent.click(screen.getByTestId('toggle'));

    expect(screen.getByTestId('toggle').textContent).toBe('light');
  });

  it('keeps the switch even when the desktop client rejects the report', async () => {
    stubDesktopBridge(vi.fn(async () => Promise.reject(new Error('bridge gone'))));
    renderWithProvider();

    await userEvent.click(screen.getByTestId('toggle'));

    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });
});
