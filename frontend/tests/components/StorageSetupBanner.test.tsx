import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { StorageSetupBanner } from '../../src/components/layout/StorageSetupBanner';
import type { AppContextType } from '../../src/contexts/AppContext';

const setCurrentPath = vi.fn();
const useAppMock = vi.fn();
vi.mock('../../src/contexts/AppContext', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/contexts/AppContext')>();
  return { ...actual, useApp: () => useAppMock() };
});

function context(overrides: Partial<AppContextType>): AppContextType {
  return {
    storageConfigured: false,
    canConfigureStorage: true,
    currentPath: ['My Files'],
    setCurrentPath,
    ...overrides,
  } as unknown as AppContextType;
}

describe('storage setup banner', () => {
  it('stays hidden while the status is unknown or storage is connected', () => {
    useAppMock.mockReturnValue(context({ storageConfigured: null }));
    const { rerender } = render(<StorageSetupBanner />);
    expect(screen.queryByRole('status')).toBeNull();

    useAppMock.mockReturnValue(context({ storageConfigured: true }));
    rerender(<StorageSetupBanner />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('sends the first user to Settings', async () => {
    useAppMock.mockReturnValue(context({}));
    render(<StorageSetupBanner />);

    await userEvent.click(screen.getByRole('button', { name: 'Set up storage' }));

    expect(setCurrentPath).toHaveBeenCalledWith(['Settings']);
  });

  it('tells everyone else to ask the administrator, with nothing to click', () => {
    useAppMock.mockReturnValue(context({ canConfigureStorage: false }));
    render(<StorageSetupBanner />);

    expect(screen.getByRole('status').textContent).toMatch(/Ask your administrator/);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('gets out of the way on the Settings page itself', () => {
    useAppMock.mockReturnValue(context({ currentPath: ['Settings'] }));
    render(<StorageSetupBanner />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
