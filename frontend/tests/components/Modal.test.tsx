import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Modal } from '../../src/components/ui/Modal';

function setup(props: Partial<React.ComponentProps<typeof Modal>> = {}) {
  const onClose = vi.fn();
  const view = render(
    <Modal isOpen onClose={onClose} title="Rename file" {...props}>
      <input aria-label="New name" />
      <button>Save</button>
    </Modal>
  );
  return { onClose, ...view };
}

afterEach(() => {
  document.body.style.overflow = '';
});

describe('visibility', () => {
  it('renders nothing when closed', () => {
    setup({ isOpen: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders the title and children when open', () => {
    setup();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Rename file')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('marks itself as a modal dialog for assistive technology', () => {
    setup();
    expect(screen.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');
  });
});

describe('closing', () => {
  it('closes on the header close button', async () => {
    const { onClose } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Close modal' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape', async () => {
    const { onClose } = setup();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });

  it('does not close on other keys', async () => {
    const { onClose } = setup();
    // Focus lands on the close button by default, and Enter would activate it;
    // move to a neutral field first so this exercises the key handler alone.
    await waitFor(() => expect(document.activeElement).not.toBe(document.body));
    screen.getByLabelText('New name').focus();

    await userEvent.keyboard('{Enter}');
    await userEvent.keyboard('abc');
    await userEvent.keyboard('{Tab}');

    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not close when the content area is clicked', async () => {
    const { onClose } = setup();
    await userEvent.click(screen.getByText('Rename file'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('stops listening for Escape once closed', async () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <Modal isOpen onClose={onClose} title="t">
        <button>x</button>
      </Modal>
    );
    rerender(
      <Modal isOpen={false} onClose={onClose} title="t">
        <button>x</button>
      </Modal>
    );

    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('uses the latest onClose, not the one captured when it opened', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(
      <Modal isOpen onClose={first} title="t">
        <button>x</button>
      </Modal>
    );
    rerender(
      <Modal isOpen onClose={second} title="t">
        <button>x</button>
      </Modal>
    );

    await userEvent.keyboard('{Escape}');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
  });
});

describe('body scroll lock', () => {
  it('locks background scrolling while open', () => {
    setup();
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('restores scrolling when closed', () => {
    const { rerender } = render(
      <Modal isOpen onClose={vi.fn()} title="t">
        <button>x</button>
      </Modal>
    );
    rerender(
      <Modal isOpen={false} onClose={vi.fn()} title="t">
        <button>x</button>
      </Modal>
    );
    expect(document.body.style.overflow).toBe('unset');
  });

  it('keeps the lock while a second modal is still open', () => {
    const { rerender } = render(
      <div>
        <Modal isOpen onClose={vi.fn()} title="first">
          <button>a</button>
        </Modal>
        <Modal isOpen onClose={vi.fn()} title="second">
          <button>b</button>
        </Modal>
      </div>
    );

    rerender(
      <div>
        <Modal isOpen onClose={vi.fn()} title="first">
          <button>a</button>
        </Modal>
        <Modal isOpen={false} onClose={vi.fn()} title="second">
          <button>b</button>
        </Modal>
      </div>
    );

    expect(document.body.style.overflow).toBe('hidden');
  });
});

describe('focus management', () => {
  it('moves focus into the modal when it opens', async () => {
    setup();
    await waitFor(() => {
      expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true);
    });
  });

  it('honours an explicit initial focus target', async () => {
    function Harness() {
      const ref = React.useRef<HTMLInputElement>(null);
      return (
        <Modal isOpen onClose={vi.fn()} title="t" initialFocusRef={ref as React.RefObject<HTMLElement>}>
          <button>first</button>
          <input aria-label="Preferred" ref={ref} />
        </Modal>
      );
    }
    render(<Harness />);
    await waitFor(() => expect(screen.getByLabelText('Preferred')).toHaveFocus());
  });
});

describe('sizes', () => {
  it.each(['sm', 'md', 'lg', 'xl', 'full'] as const)('renders at size %s', size => {
    expect(() => setup({ size })).not.toThrow();
    expect(screen.getAllByRole('dialog').length).toBeGreaterThan(0);
  });
});
