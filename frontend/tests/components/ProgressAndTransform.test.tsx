import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Trash2 } from 'lucide-react';
import { FixedProgress } from '../../src/components/fileManager/FixedProgress';
import { DeleteProgress } from '../../src/components/fileManager/DeleteProgress';
import { DownloadProgress } from '../../src/components/fileManager/DownloadProgress';
import { DesktopOpenProgress } from '../../src/components/fileManager/DesktopOpenProgress';
import { clampPan } from '../../src/components/viewer/imageTransform';
import { clampPercent } from '../../src/components/fileManager/progressUtils';

describe('progress components', () => {
  it('FixedProgress keeps its fixed positioning and 80-wide card', () => {
    const { container } = render(<FixedProgress icon={Trash2} title="t" percent={42} showPercentBadge />);
    const outer = container.firstElementChild as HTMLElement;
    expect(outer.className).toContain('fixed');
    expect(outer.className).toContain('bottom-4');
    expect(outer.firstElementChild?.className).toContain('w-80');
    expect(container.textContent).toContain('42%');
    const bar = container.querySelector('.bg-red-500') as HTMLElement;
    expect(bar.style.width).toBe('42%');
  });

  it('DownloadProgress shows a determinate bar and filename for a tracked download', () => {
    const { container } = render(
      <DownloadProgress
        downloads={[{ id: 'd1', fileName: 'report.pdf', fileSize: 1000, progress: 42, status: 'downloading' }]}
        onDismiss={() => {}}
      />
    );
    expect(container.textContent).toContain('report.pdf');
    expect(container.textContent).toContain('42%');
    const bar = container.querySelector('.bg-\\[var\\(--accent\\)\\]') as HTMLElement;
    expect(bar.style.width).toBe('42%');
  });

  it('DownloadProgress pulses an indeterminate bar for a streamed ZIP', () => {
    const { container } = render(
      <DownloadProgress
        downloads={[
          { id: 'z1', fileName: '3 items', fileSize: 0, progress: 0, status: 'zipping', indeterminate: true },
        ]}
        onDismiss={() => {}}
      />
    );
    const bar = container.querySelector('.bg-blue-500') as HTMLElement;
    expect(bar.className).toContain('animate-pulse');
    expect(bar.style.width).toBe('100%');
  });

  it('DeleteProgress still renders label, count and red bar', () => {
    const { container } = render(<DeleteProgress progress={{ itemCount: 3, percent: 10, label: 'Deleting' }} />);
    expect(container.textContent).toContain('Deleting');
    expect(container.textContent).toContain('3 items selected');
    expect(container.querySelector('.bg-red-500')).not.toBeNull();
  });

  it('DesktopOpenProgress stacks one card per item with clamped percent', () => {
    const { container } = render(
      <DesktopOpenProgress
        items={[
          { fileId: 'a', fileName: 'a.txt', percent: 55 },
          { fileId: 'b', fileName: 'b.txt', percent: 999 },
        ]}
      />
    );
    expect(container.querySelectorAll('.w-80')).toHaveLength(2);
    expect(container.textContent).toContain('Opening file… 55%');
    expect(container.textContent).toContain('Opening file… 100%');
    expect(container.textContent).toContain('a.txt');
  });
});

describe('extracted helpers', () => {
  it('clampPercent guards NaN and range', () => {
    expect(clampPercent(NaN)).toBe(0);
    expect(clampPercent(null)).toBe(0);
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(150)).toBe(100);
    expect(clampPercent(33)).toBe(33);
  });

  it('clampPan centres content smaller than the container', () => {
    expect(clampPan({ x: 999, y: -999 }, 100, 100, 40, 60)).toEqual({ x: 30, y: 20 });
  });

  it('clampPan clamps content larger than the container to its edges', () => {
    expect(clampPan({ x: 50, y: -500 }, 100, 100, 200, 200)).toEqual({ x: 0, y: -100 });
    expect(clampPan({ x: -30, y: -30 }, 100, 100, 200, 200)).toEqual({ x: -30, y: -30 });
  });
});
