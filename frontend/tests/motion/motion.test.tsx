import React from 'react';
import { act, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { nearestSnapPoint, project, projectedEndpoint, rubberband, rubberbandClamp } from '../../src/motion/physics';
import { VelocityTracker } from '../../src/motion/physics';
import { useScrollEdge } from '../../src/motion/useScrollEdge';

describe('momentum projection', () => {
  it('projects further the harder the flick', () => {
    expect(project(2000)).toBeGreaterThan(project(500));
  });

  it('projects in the direction of travel', () => {
    expect(project(-1000)).toBeLessThan(0);
  });

  it('goes nowhere when the gesture ended at rest', () => {
    expect(project(0)).toBe(0);
  });

  it('decelerates sooner at a lower deceleration rate', () => {
    expect(Math.abs(project(1000, 0.99))).toBeLessThan(Math.abs(project(1000, 0.998)));
  });

  it('offsets the endpoint from where the finger actually let go', () => {
    expect(projectedEndpoint(100, 1000)).toBeCloseTo(100 + project(1000), 5);
  });

  it('picks the snap point nearest the projection, not the release point', () => {
    // Released at 10 but thrown hard: the far snap point is the intended one.
    const landing = projectedEndpoint(10, 1200);
    expect(nearestSnapPoint(landing, [0, 600])).toBe(600);
    expect(nearestSnapPoint(projectedEndpoint(10, 0), [0, 600])).toBe(0);
  });
});

describe('rubber-banding', () => {
  it('gives less the further past the boundary the drag goes', () => {
    const first = rubberband(50, 500) - rubberband(0, 500);
    const later = rubberband(400, 500) - rubberband(350, 500);
    expect(later).toBeLessThan(first);
  });

  it('never travels as far as the overshoot itself', () => {
    expect(rubberband(200, 500)).toBeLessThan(200);
  });

  it('leaves values inside the bounds untouched', () => {
    expect(rubberbandClamp(50, 0, 100, 500)).toBe(50);
  });

  it('resists rather than clamping outside the bounds', () => {
    const over = rubberbandClamp(160, 0, 100, 500);
    expect(over).toBeGreaterThan(100);
    expect(over).toBeLessThan(160);

    const under = rubberbandClamp(-60, 0, 100, 500);
    expect(under).toBeLessThan(0);
    expect(under).toBeGreaterThan(-60);
  });

  it('has no give when there is no extent to give against', () => {
    expect(rubberband(100, 0)).toBe(0);
  });
});

describe('VelocityTracker', () => {
  it('reports nothing from a single sample', () => {
    const t = new VelocityTracker();
    t.add(0, 0);
    expect(t.velocity).toBe(0);
  });

  it('measures px/s across the window', () => {
    const t = new VelocityTracker();
    t.add(0, 0);
    t.add(100, 100);
    expect(t.velocity).toBeCloseTo(1000, 5);
  });

  it('signs the velocity by direction', () => {
    const t = new VelocityTracker();
    t.add(100, 0);
    t.add(0, 100);
    expect(t.velocity).toBeCloseTo(-1000, 5);
  });

  it('forgets samples older than its window, so a pause reads as a stop', () => {
    const t = new VelocityTracker(100);
    t.add(0, 0);
    t.add(500, 50);
    // Long pause with the finger still down, then release from the same spot.
    t.add(500, 400);
    t.add(500, 450);
    expect(Math.abs(t.velocity)).toBeLessThan(1);
  });

  it('drops everything on reset', () => {
    const t = new VelocityTracker();
    t.add(0, 0);
    t.add(100, 100);
    t.reset();
    expect(t.velocity).toBe(0);
  });
});

describe('useScrollEdge', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function Harness({ onReady }: { onReady: (el: HTMLDivElement) => void }) {
    const { ref, scrolled } = useScrollEdge<HTMLDivElement>();
    React.useEffect(() => {
      if (ref.current) onReady(ref.current);
    }, [ref, onReady]);
    return <div ref={ref} data-testid="pane" data-edge={String(scrolled)} />;
  }

  function mount() {
    let node!: HTMLDivElement;
    const view = render(<Harness onReady={el => (node = el)} />);
    return { node, view };
  }

  const scrollTo = (node: HTMLElement, top: number) => {
    node.scrollTop = top;
    node.dispatchEvent(new Event('scroll'));
  };

  it('starts idle and unscrolled', () => {
    const { node } = mount();
    expect(node.dataset.scrolling).toBe('false');
    expect(node.dataset.edge).toBe('false');
  });

  it('marks itself as scrolling the moment the user scrolls', () => {
    const { node } = mount();
    act(() => scrollTo(node, 200));
    expect(node.dataset.scrolling).toBe('true');
  });

  it('recedes once scrolling stops', () => {
    const { node } = mount();
    act(() => scrollTo(node, 200));
    act(() => void vi.advanceTimersByTime(1000));
    expect(node.dataset.scrolling).toBe('false');
  });

  it('stays out while the user keeps scrolling', () => {
    const { node } = mount();
    act(() => scrollTo(node, 100));
    act(() => void vi.advanceTimersByTime(600));
    act(() => scrollTo(node, 200));
    act(() => void vi.advanceTimersByTime(600));
    expect(node.dataset.scrolling).toBe('true');
  });

  it('raises the edge only once content has passed under the chrome', () => {
    const { node } = mount();
    act(() => {
      scrollTo(node, 2);
      vi.advanceTimersByTime(50);
    });
    expect(node.dataset.edge).toBe('false');

    act(() => {
      scrollTo(node, 40);
      vi.advanceTimersByTime(50);
    });
    expect(node.dataset.edge).toBe('true');
  });

  it('lowers the edge again at the top', () => {
    const { node } = mount();
    act(() => {
      scrollTo(node, 40);
      vi.advanceTimersByTime(50);
    });
    act(() => {
      scrollTo(node, 0);
      vi.advanceTimersByTime(50);
    });
    expect(node.dataset.edge).toBe('false');
  });

  it('stops listening once unmounted', () => {
    const { node, view } = mount();
    view.unmount();
    expect(() => act(() => scrollTo(node, 300))).not.toThrow();
    expect(node.dataset.scrolling).toBe('false');
  });
});

describe('useScrollEdge with no node', () => {
  it('does not blow up when the ref was never attached', () => {
    expect(() => renderHook(() => useScrollEdge<HTMLDivElement>())).not.toThrow();
  });
});
