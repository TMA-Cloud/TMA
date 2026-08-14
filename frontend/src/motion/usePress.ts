import { useCallback, useRef, useState } from 'react';

export interface PressOptions {
  /** Slack around the target before the press is treated as abandoned. Real
   *  fingers wander; a few px of drift is not a change of mind. */
  slop?: number;
  disabled?: boolean;
}

/**
 * Instant press feedback.
 *
 * The highlight goes on at pointer-down, not on click. Waiting for the release
 * to acknowledge a press is the single clearest way to make an interface feel
 * dead — the moment lag appears, directness falls off a cliff.
 *
 * Dragging away cancels the press and dragging back restores it, so the user
 * can change their mind without lifting.
 */
export function usePress<T extends HTMLElement>({ slop = 10, disabled = false }: PressOptions = {}) {
  const [holding, setHolding] = useState(false);
  const origin = useRef<{ x: number; y: number; id: number } | null>(null);
  const bounds = useRef<DOMRect | null>(null);

  // A control that has just been disabled cannot still be showing a press, so
  // this is derived rather than synchronised — there is no second state to
  // fall out of step.
  const pressed = holding && !disabled;

  const release = useCallback(() => {
    origin.current = null;
    bounds.current = null;
    setHolding(false);
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<T>) => {
      if (disabled || event.button !== 0) return;
      origin.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
      bounds.current = event.currentTarget.getBoundingClientRect();
      setHolding(true);
    },
    [disabled]
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<T>) => {
      const start = origin.current;
      const box = bounds.current;
      if (!start || !box || event.pointerId !== start.id) return;

      const inside =
        event.clientX >= box.left - slop &&
        event.clientX <= box.right + slop &&
        event.clientY >= box.top - slop &&
        event.clientY <= box.bottom + slop;

      setHolding(inside);
    },
    [slop]
  );

  const onPointerUp = useCallback(() => release(), [release]);
  const onPointerLeave = useCallback(() => setHolding(false), []);
  const onPointerCancel = useCallback(() => release(), [release]);

  return {
    pressed,
    pressProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerLeave,
      onPointerCancel,
      'data-pressed': pressed ? ('true' as const) : undefined,
    },
  };
}
