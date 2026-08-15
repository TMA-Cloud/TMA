import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { RecentFiles } from '../../src/components/dashboard/RecentFiles';
import type { FileItem } from '../../src/contexts/AppContext';

const HOUR = 60 * 60 * 1000;

function file(overrides: Partial<FileItem> = {}): FileItem {
  return {
    id: 'f1',
    name: 'notes.txt',
    type: 'file',
    size: 2048,
    modified: new Date(Date.now() - 90 * 24 * HOUR),
    accessedAt: new Date(Date.now() - 2 * HOUR),
    ...overrides,
  };
}

/**
 * The visible row labels, in order. Each name also appears inside its tooltip,
 * so this reads the row itself rather than every node carrying the text.
 */
function names(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('p.truncate')).map(node => node.textContent ?? '');
}

describe('RecentFiles', () => {
  it('says so plainly when the account has opened nothing', () => {
    render(<RecentFiles files={[]} />);
    expect(screen.getByText('Nothing here yet.')).toBeInTheDocument();
  });

  it('renders the server order rather than sorting again', () => {
    const { container } = render(
      <RecentFiles
        files={[
          file({ id: 'a', name: 'newest.txt' }),
          file({ id: 'b', name: 'older.txt' }),
          file({ id: 'c', name: 'oldest.txt' }),
        ]}
      />
    );

    expect(names(container)).toEqual(['newest.txt', 'older.txt', 'oldest.txt']);
  });

  it('shows every row it is given, because the server already trimmed the list', () => {
    const files = Array.from({ length: 5 }, (_, i) => file({ id: `f${i}`, name: `file${i}.txt` }));
    const { container } = render(<RecentFiles files={files} />);

    expect(names(container)).toHaveLength(5);
  });

  it('dates each row by when it was opened, not when it changed', () => {
    // A file last edited three months ago but opened this morning belongs at
    // the top of this list, and has to read that way.
    render(<RecentFiles files={[file({ accessedAt: new Date(Date.now() - 3 * HOUR) })]} />);

    expect(screen.getByText(/^Opened /)).toBeInTheDocument();
    expect(screen.queryByText(/months ago/)).not.toBeInTheDocument();
  });

  it('falls back to the modified date if the server sent no access time', () => {
    render(<RecentFiles files={[file({ accessedAt: undefined })]} />);
    expect(screen.getByText(/^Opened /)).toBeInTheDocument();
  });

  it('pairs the size with the timestamp', () => {
    const { container } = render(<RecentFiles files={[file({ size: 2048 })]} />);
    const row = container.querySelector('.space-y-0\\.5 > div') as HTMLElement;

    expect(within(row).getByText('2KB')).toBeInTheDocument();
  });
});
