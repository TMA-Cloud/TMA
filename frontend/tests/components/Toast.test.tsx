import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Toast, ToastContainer } from '../../src/components/ui/Toast';
import { ToastProvider } from '../../src/hooks/ToastProvider';
import { useToast } from '../../src/hooks/useToast';

describe('Toast', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it('shows the message with a polite live region', () => {
    render(<Toast id="1" message="File uploaded" onClose={vi.fn()} />);
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('File uploaded');
    expect(status).toHaveAttribute('aria-live', 'polite');
  });

  it('closes when dismissed by the user', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Toast id="1" message="x" onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: 'Close notification' }));
    act(() => void vi.advanceTimersByTime(300));

    expect(onClose).toHaveBeenCalledWith('1');
  });

  it('auto-dismisses after its duration', () => {
    const onClose = vi.fn();
    render(<Toast id="1" message="x" duration={1000} onClose={onClose} />);

    act(() => void vi.advanceTimersByTime(1000));
    expect(onClose).not.toHaveBeenCalled();

    act(() => void vi.advanceTimersByTime(300));
    expect(onClose).toHaveBeenCalledWith('1');
  });

  it('only closes once, even if dismissed and then auto-dismissed', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Toast id="1" message="x" duration={1000} onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: 'Close notification' }));
    act(() => void vi.advanceTimersByTime(5000));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it.each(['success', 'error', 'info'] as const)('renders the %s variant', type => {
    expect(() => render(<Toast id="1" message="x" type={type} onClose={vi.fn()} />)).not.toThrow();
  });

  it('does not fire onClose after unmount', () => {
    const onClose = vi.fn();
    const { unmount } = render(<Toast id="1" message="x" duration={1000} onClose={onClose} />);
    unmount();
    act(() => void vi.advanceTimersByTime(5000));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('ToastContainer', () => {
  it('renders every toast it is given', () => {
    render(
      <ToastContainer
        toasts={[
          { id: '1', message: 'first' },
          { id: '2', message: 'second' },
        ]}
        onClose={vi.fn()}
      />
    );
    expect(screen.getAllByRole('status')).toHaveLength(2);
  });

  it('renders nothing for an empty list', () => {
    render(<ToastContainer toasts={[]} onClose={vi.fn()} />);
    expect(screen.queryAllByRole('status')).toHaveLength(0);
  });
});

describe('ToastProvider', () => {
  function Trigger({ label, message, type }: { label: string; message: string; type?: 'success' | 'error' | 'info' }) {
    const { showToast } = useToast();
    return <button onClick={() => showToast(message, type)}>{label}</button>;
  }

  it('shows a toast when a child asks for one', async () => {
    render(
      <ToastProvider>
        <Trigger label="go" message="Saved" type="success" />
      </ToastProvider>
    );

    await userEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(screen.getByText('Saved')).toBeInTheDocument();
  });

  it('suppresses an identical toast fired again within a second', async () => {
    render(
      <ToastProvider>
        <Trigger label="go" message="Saved" type="success" />
      </ToastProvider>
    );

    const button = screen.getByRole('button', { name: 'go' });
    await userEvent.click(button);
    await userEvent.click(button);

    expect(screen.getAllByText('Saved')).toHaveLength(1);
  });

  it('does not suppress a different message', async () => {
    render(
      <ToastProvider>
        <Trigger label="a" message="First" />
        <Trigger label="b" message="Second" />
      </ToastProvider>
    );

    await userEvent.click(screen.getByRole('button', { name: 'a' }));
    await userEvent.click(screen.getByRole('button', { name: 'b' }));

    expect(screen.getByText('First')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
  });

  it('does not suppress the same message at a different severity', async () => {
    render(
      <ToastProvider>
        <Trigger label="ok" message="Done" type="success" />
        <Trigger label="bad" message="Done" type="error" />
      </ToastProvider>
    );

    await userEvent.click(screen.getByRole('button', { name: 'ok' }));
    await userEvent.click(screen.getByRole('button', { name: 'bad' }));

    expect(screen.getAllByText('Done')).toHaveLength(2);
  });

  it('shows at most three toasts, keeping the newest', async () => {
    function Multi() {
      const { showToast } = useToast();
      return (
        <button
          onClick={() => {
            ['one', 'two', 'three', 'four'].forEach(m => showToast(m));
          }}
        >
          burst
        </button>
      );
    }

    render(
      <ToastProvider>
        <Multi />
      </ToastProvider>
    );

    await userEvent.click(screen.getByRole('button', { name: 'burst' }));

    await waitFor(() => expect(screen.getAllByRole('status')).toHaveLength(3));
    expect(screen.queryByText('one')).not.toBeInTheDocument();
    expect(screen.getByText('four')).toBeInTheDocument();
  });
});
