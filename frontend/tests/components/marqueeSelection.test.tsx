import { act, fireEvent, render, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Virtualizer } from '@tanstack/react-virtual';
import { useMarqueeGeometry } from '../../src/components/fileManager/hooks/useMarqueeGeometry';
import { MarqueeSelector } from '../../src/components/fileManager/MarqueeSelector';
import { virtualSelectionIds, type SelectionBounds } from '../../src/components/fileManager/marqueeGeometry';

const ids = Array.from({ length: 100 }, (_, i) => `file-${i}`);
const rows = ids.map((_, index) => ({ start: 80 + index * 53, end: 80 + (index + 1) * 53, size: 53 }));
const hitTest = (rect: SelectionBounds) => virtualSelectionIds(rect, rows, ids, 1, 300, 80, 4, new Map());

afterEach(() => vi.unstubAllGlobals());

describe('virtual marquee geometry', () => {
  it('selects offscreen rows and removes them when the rectangle shrinks', () => {
    expect(hitTest({ left: 0, top: 0, width: 100, height: 1059 })).toEqual(ids.slice(0, 20));
    expect(hitTest({ left: 0, top: 0, width: 100, height: 70 })).toEqual(ids.slice(0, 2));
    expect(hitTest({ left: 0, top: 1060, width: 100, height: 52 })).toEqual([ids[20]]);
  });

  it('respects grid columns, gaps, trailing empty cells and measured card heights', () => {
    const gridRows = [
      { start: 80, end: 270, size: 190 },
      { start: 270, end: 460, size: 190 },
    ];
    const gridIds = ['a', 'b', 'c'];
    const select = (rect: SelectionBounds) =>
      virtualSelectionIds(rect, gridRows, gridIds, 2, 312, 80, 12, new Map([['a', 100]]));
    expect(select({ left: 155, top: 0, width: 1, height: 380 })).toEqual([]);
    expect(select({ left: 162, top: 0, width: 150, height: 380 })).toEqual(['b']);
    expect(select({ left: 0, top: 110, width: 312, height: 5 })).toEqual(['b']);
    expect(select({ left: 0, top: 190, width: 312, height: 100 })).toEqual(['c']);
  });
});

describe('marquee layout adapter', () => {
  it('reads CSS spacing and keeps measured card heights after their DOM nodes unmount', () => {
    const container = document.createElement('div');
    Object.defineProperty(container, 'clientWidth', { value: 312 });
    const row = document.createElement('div');
    row.dataset.index = '0';
    row.style.columnGap = '9.75px';
    row.style.paddingBottom = '9.75px';
    container.append(row);
    for (const [id, height] of [
      ['a', 100],
      ['b', 115],
    ] as const) {
      const card = document.createElement('div');
      card.dataset.fileId = id;
      vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({ height } as DOMRect);
      row.append(card);
    }
    const layout = { measurementsCache: [{ start: 80, end: 206, size: 126 }] } as unknown as Virtualizer<
      HTMLElement,
      Element
    >;
    const ref = { current: container };
    const hook = renderHook(() => useMarqueeGeometry(ref, layout, ['a', 'b'], 2, 312, 80, 'grid'));
    expect(hook.result.current({ left: 160, top: 0, width: 1, height: 100 })).toEqual(['b']);
    row.replaceChildren();
    expect(hook.result.current({ left: 0, top: 105, width: 312, height: 1 })).toEqual(['b']);
    expect(hook.result.current({ left: 152, top: 0, width: 8, height: 100 })).toEqual([]);
  });
});

function setup(additive = false) {
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      frame = callback;
      return 1;
    })
  );
  vi.stubGlobal(
    'cancelAnimationFrame',
    vi.fn(() => {
      frame = undefined;
    })
  );
  const flush = () =>
    act(() => {
      const callback = frame;
      frame = undefined;
      callback?.(0);
    });
  const onSelectionChange = vi.fn();
  const onSelectingChange = vi.fn();
  let scroll = 0;
  const view = render(
    <main>
      <MarqueeSelector
        getSelectionIds={hitTest}
        onSelectionChange={onSelectionChange}
        onSelectingChange={onSelectingChange}
      >
        <div data-file-id="file-0" />
      </MarqueeSelector>
    </main>
  );
  const wrapper = view.container.querySelector('main')!.firstElementChild!;
  vi.spyOn(wrapper, 'getBoundingClientRect').mockImplementation(
    () => ({ left: 0, top: 80 - scroll, width: 300, height: 5300 }) as DOMRect
  );
  fireEvent.mouseDown(wrapper, { button: 0, clientX: 10, clientY: 81, ctrlKey: additive });
  return {
    view,
    wrapper,
    onSelectionChange,
    flush,
    scrollTo: (value: number) => {
      scroll = value;
      fireEvent.scroll(view.container.querySelector('main')!);
    },
  };
}

describe('marquee scroll gestures', () => {
  it('retains unmounted hits on scroll without pointer movement, then shrinks and commits on mouseup', () => {
    const test = setup();
    fireEvent.mouseMove(document, { clientX: 200, clientY: 150 });
    test.flush();
    expect(test.onSelectionChange).toHaveBeenLastCalledWith(ids.slice(0, 2), false);
    test.view.rerender(
      <main>
        <MarqueeSelector getSelectionIds={hitTest} onSelectionChange={test.onSelectionChange}>
          <div data-file-id="file-20" />
        </MarqueeSelector>
      </main>
    );
    test.scrollTo(1060);
    test.flush();
    expect(test.onSelectionChange).toHaveBeenLastCalledWith(ids.slice(0, 22), false);
    const box = test.view.container.querySelector('.marquee-selection') as HTMLElement;
    expect(box.style.top).toBe('1px');
    expect(box.style.height).toBe('1129px');
    test.scrollTo(0);
    test.flush();
    expect(test.onSelectionChange).toHaveBeenLastCalledWith(ids.slice(0, 2), false);
    test.scrollTo(1060);
    fireEvent.mouseUp(document, { clientX: 200, clientY: 150 });
    expect(test.onSelectionChange).toHaveBeenLastCalledWith(ids.slice(0, 22), false);
    expect(test.view.container.querySelector('.marquee-selection')).toBeNull();
    const calls = test.onSelectionChange.mock.calls.length;
    test.scrollTo(0);
    test.flush();
    expect(test.onSelectionChange).toHaveBeenCalledTimes(calls);
  });

  it('coalesces movement using the latest pointer and preserves additive mode', () => {
    const test = setup(true);
    fireEvent.mouseMove(document, { clientX: 200, clientY: 150 });
    fireEvent.mouseMove(document, { clientX: 200, clientY: 250 });
    test.flush();
    expect(test.onSelectionChange).toHaveBeenCalledExactlyOnceWith(ids.slice(0, 4), true);
  });

  it('uses fresh layout data if more files load during a drag', () => {
    const test = setup();
    fireEvent.mouseMove(document, { clientX: 200, clientY: 150 });
    test.flush();
    const latest = vi.fn(() => ['new-file']);
    test.view.rerender(
      <main>
        <MarqueeSelector getSelectionIds={latest} onSelectionChange={test.onSelectionChange}>
          <div />
        </MarqueeSelector>
      </main>
    );
    test.scrollTo(1060);
    test.flush();
    expect(test.onSelectionChange).toHaveBeenLastCalledWith(['new-file'], false);
  });

  it('cancels queued frames and scroll listeners when unmounted mid-drag', () => {
    const test = setup();
    fireEvent.mouseMove(document, { clientX: 200, clientY: 150 });
    test.flush();
    test.scrollTo(1060);
    const calls = test.onSelectionChange.mock.calls.length;
    test.view.unmount();
    test.flush();
    fireEvent.scroll(document);
    expect(test.onSelectionChange).toHaveBeenCalledTimes(calls);
    expect(cancelAnimationFrame).toHaveBeenCalled();
  });
});
