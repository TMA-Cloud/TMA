import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { PermissionChecklist } from '../../src/components/settings/components/PermissionChecklist';
import type { PermissionDefinition } from '../../src/utils/api';

/** Mirrors the catalog the server serves, in its intended display order. */
const CATALOG: PermissionDefinition[] = [
  { key: 'files.download', label: 'Download', description: 'Download files and folders' },
  { key: 'files.upload', label: 'Upload & create', description: 'Upload files and create folders' },
  { key: 'files.edit', label: 'Modify', description: 'Rename, move, star' },
  { key: 'files.share', label: 'Share', description: 'Create and revoke share links' },
  { key: 'files.delete', label: 'Move to trash', description: 'Send items to the trash' },
  { key: 'files.trash', label: 'Manage trash', description: 'Restore and permanently delete' },
];

function setup(props: Partial<React.ComponentProps<typeof PermissionChecklist>> = {}) {
  const onChange = vi.fn();
  const view = render(
    <PermissionChecklist available={CATALOG} value={[]} onChange={onChange} idPrefix="test" {...props} />
  );
  return { onChange, ...view };
}

describe('rendering', () => {
  it('shows a row per capability with its label and description', () => {
    setup();
    for (const permission of CATALOG) {
      expect(screen.getByText(permission.label)).toBeInTheDocument();
      expect(screen.getByText(permission.description)).toBeInTheDocument();
    }
  });

  it('renders one checkbox per capability', () => {
    setup();
    expect(screen.getAllByRole('checkbox')).toHaveLength(CATALOG.length);
  });

  it('ticks exactly the granted capabilities', () => {
    setup({ value: ['files.download', 'files.share'] });
    expect(screen.getByLabelText(/Download/)).toBeChecked();
    expect(screen.getByLabelText(/Share/)).toBeChecked();
    expect(screen.getByLabelText(/Move to trash/)).not.toBeChecked();
  });

  it('namespaces input ids so two checklists can coexist', () => {
    const { container } = render(
      <div>
        <PermissionChecklist available={CATALOG} value={[]} onChange={vi.fn()} idPrefix="create" />
        <PermissionChecklist available={CATALOG} value={[]} onChange={vi.fn()} idPrefix="edit" />
      </div>
    );
    expect(container.querySelector('#create-files\\.download')).toBeTruthy();
    expect(container.querySelector('#edit-files\\.download')).toBeTruthy();
  });

  it('warns when nothing is ticked, so the owner knows browse-only is intentional', () => {
    setup({ value: [] });
    expect(screen.getByText(/can browse and search but cannot download or change anything/i)).toBeInTheDocument();
  });

  it('drops the warning once something is granted', () => {
    setup({ value: ['files.download'] });
    expect(screen.queryByText(/can browse and search but cannot/i)).not.toBeInTheDocument();
  });
});

describe('toggling', () => {
  it('adds a capability when its box is ticked', async () => {
    const { onChange } = setup({ value: [] });
    await userEvent.click(screen.getByLabelText(/Download/));
    expect(onChange).toHaveBeenCalledWith(['files.download']);
  });

  it('removes a capability when its box is unticked', async () => {
    const { onChange } = setup({ value: ['files.download', 'files.upload'] });
    await userEvent.click(screen.getByLabelText(/Download/));
    expect(onChange).toHaveBeenCalledWith(['files.upload']);
  });

  it('emits keys in catalog order regardless of the order they were ticked', async () => {
    const { onChange } = setup({ value: ['files.trash'] });
    await userEvent.click(screen.getByLabelText(/Download/));
    expect(onChange).toHaveBeenCalledWith(['files.download', 'files.trash']);
  });

  it('never emits a duplicate key', async () => {
    const { onChange } = setup({ value: ['files.download', 'files.download'] });
    await userEvent.click(screen.getByLabelText(/Upload & create/));
    const emitted = onChange.mock.calls[0]?.[0] as string[];
    expect(new Set(emitted).size).toBe(emitted.length);
  });

  it('can be toggled by clicking the row label, not just the box', async () => {
    const { onChange } = setup({ value: [] });
    await userEvent.click(screen.getByText('Download'));
    expect(onChange).toHaveBeenCalledWith(['files.download']);
  });
});

describe('bulk actions', () => {
  it('"Allow all" grants every capability in catalog order', async () => {
    const { onChange } = setup({ value: [] });
    await userEvent.click(screen.getByRole('button', { name: 'Allow all' }));
    expect(onChange).toHaveBeenCalledWith(CATALOG.map(p => p.key));
  });

  it('"Clear all" revokes everything', async () => {
    const { onChange } = setup({ value: CATALOG.map(p => p.key) });
    await userEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('disables "Allow all" when everything is already granted', () => {
    setup({ value: CATALOG.map(p => p.key) });
    expect(screen.getByRole('button', { name: 'Allow all' })).toBeDisabled();
  });

  it('disables "Clear all" when nothing is granted', () => {
    setup({ value: [] });
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeDisabled();
  });

  it('enables both buttons for a partial selection', () => {
    setup({ value: ['files.download'] });
    expect(screen.getByRole('button', { name: 'Allow all' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeEnabled();
  });
});

describe('disabled state', () => {
  it('disables every checkbox', () => {
    setup({ disabled: true });
    for (const box of screen.getAllByRole('checkbox')) {
      expect(box).toBeDisabled();
    }
  });

  it('disables the bulk buttons', () => {
    setup({ value: ['files.download'], disabled: true });
    expect(screen.getByRole('button', { name: 'Allow all' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear all' })).toBeDisabled();
  });

  it('does not emit a change when a disabled row is clicked', async () => {
    const { onChange } = setup({ disabled: true });
    await userEvent.click(screen.getByText('Download'));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('empty catalog', () => {
  it('renders without crashing when the server sends no capabilities', () => {
    expect(() =>
      render(<PermissionChecklist available={[]} value={[]} onChange={vi.fn()} idPrefix="x" />)
    ).not.toThrow();
  });

  it('leaves "Allow all" enabled but harmless when there is nothing to grant', async () => {
    const onChange = vi.fn();
    render(<PermissionChecklist available={[]} value={[]} onChange={onChange} idPrefix="x" />);
    await userEvent.click(screen.getByRole('button', { name: 'Allow all' }));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
