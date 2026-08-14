import { useCallback, useEffect, useRef } from 'react';
import { VelocityTracker } from './physics';

export interface DragState {
  /** Movement since the grab, in px. */
  dx: number;
  dy: number;
  /** Release velocity in px/s — hand this to whatever animates next. */
  vx: number;
  vy: number;
  /** Where inside the element the grab landed, so it can stay under the
   *  pointer instead of jumping to its own centre. */
  grabOffsetX: number;
  grabOffsetY: number;
  event: PointerEvent;
}

export interface DragOptions {
  /** Which axis commits the gesture. 'both' never disambiguates. */
  axis?: 'x' | 'y' | 'both';
  /**
   * Movement required before the drag commits. Without it every tap wobbles;
   * with too much, the content visibly lags the finger at the start.
   */
  threshold?: number;
  disabled?: boolean;
  onStart?: (state: DragState) => void;
  /** Fires on every pointermove once committed. Feedback has to be continuous
   *  through the gesture, not saved up for the end. */
  onMove?: (state: DragState) => void;
  onEnd?: (state: DragState) => void;
  /** The gesture left the axis it committed to, or the pointer was cancelled. */
  onCancel?: () => void;
}

/**
 * Capture keeps the pointer stream coming when the pointer leaves the
 * element's box, which is the normal case for any drag worth making. It is not
 * load-bearing though — the move and up listeners are on the window either way
 * — so an environment without it degrades to plain tracking rather than
 * throwing part-way through a gesture.
 */
function takeCapture(element: Element | null, pointerId: number) {
  if (typeof element?.setPointerCapture !== 'function') return;
  try {
    element.setPointerCapture(pointerId);
  } catch {
    // The pointer was already released; nothing to hold on to.
  }
}

function releaseCapture(element: Element | null, pointerId: number) {
  if (typeof element?.hasPointerCapture !== 'function') return;
  if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId);
}

/**
 * One-to-one pointer tracking.
 *
 * Content stays glued to the finger for as long as it is held: pointer capture
 * keeps the stream alive when the pointer leaves the element's box, and the
 * grab offset is preserved so the thing does not snap to its own centre the
 * instant it is picked up.
 *
 * Both plausible directions are watched from the first move and the loser is
 * dropped once intent is clear, rather than waiting on a recogniser that only
 * reports a final `swipeleft`-shaped verdict — by then the continuous feedback
 * the gesture needed is already gone.
 */
export function useDrag<T extends HTMLElement>(options: DragOptions = {}) {
  const { axis = 'both', threshold = 10, disabled = false } = options;

  // Kept fresh so a gesture in flight always calls the latest callbacks
  // without having to tear down and rebind its listeners mid-drag.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const state = useRef({
    active: false,
    committed: false,
    pointerId: -1,
    startX: 0,
    startY: 0,
    grabOffsetX: 0,
    grabOffsetY: 0,
    element: null as T | null,
  });

  const trackerX = useRef(new VelocityTracker());
  const trackerY = useRef(new VelocityTracker());

  const buildState = useCallback((event: PointerEvent): DragState => {
    const s = state.current;
    return {
      dx: event.clientX - s.startX,
      dy: event.clientY - s.startY,
      vx: trackerX.current.velocity,
      vy: trackerY.current.velocity,
      grabOffsetX: s.grabOffsetX,
      grabOffsetY: s.grabOffsetY,
      event,
    };
  }, []);

  const finish = useCallback(
    (event: PointerEvent, cancelled: boolean) => {
      const s = state.current;
      if (!s.active) return;

      const wasCommitted = s.committed;
      s.active = false;
      s.committed = false;

      releaseCapture(s.element, s.pointerId);

      if (!wasCommitted) {
        trackerX.current.reset();
        trackerY.current.reset();
        return;
      }

      if (cancelled) {
        optionsRef.current.onCancel?.();
      } else {
        optionsRef.current.onEnd?.(buildState(event));
      }

      trackerX.current.reset();
      trackerY.current.reset();
    },
    [buildState]
  );

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      const s = state.current;
      if (!s.active || event.pointerId !== s.pointerId) return;

      trackerX.current.add(event.clientX, event.timeStamp);
      trackerY.current.add(event.clientY, event.timeStamp);

      const dx = event.clientX - s.startX;
      const dy = event.clientY - s.startY;

      if (!s.committed) {
        const travelled = Math.hypot(dx, dy);
        if (travelled < threshold) return;

        // Intent is now clear enough to pick a winner. If it went the other
        // way, drop the gesture rather than half-tracking it.
        if (axis === 'x' && Math.abs(dx) < Math.abs(dy)) {
          finish(event, true);
          return;
        }
        if (axis === 'y' && Math.abs(dy) < Math.abs(dx)) {
          finish(event, true);
          return;
        }

        s.committed = true;
        takeCapture(s.element, event.pointerId);
        optionsRef.current.onStart?.(buildState(event));
      }

      optionsRef.current.onMove?.(buildState(event));
    },
    [axis, threshold, finish, buildState]
  );

  const onPointerUp = useCallback((event: PointerEvent) => finish(event, false), [finish]);
  const onPointerCancel = useCallback((event: PointerEvent) => finish(event, true), [finish]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<T>) => {
      if (disabled || event.button !== 0) return;

      const element = event.currentTarget;
      const bounds = element.getBoundingClientRect();
      const s = state.current;

      s.active = true;
      s.committed = false;
      s.pointerId = event.pointerId;
      s.startX = event.clientX;
      s.startY = event.clientY;
      s.grabOffsetX = event.clientX - bounds.left;
      s.grabOffsetY = event.clientY - bounds.top;
      s.element = element;

      trackerX.current.reset();
      trackerY.current.reset();
      trackerX.current.add(event.clientX, event.timeStamp);
      trackerY.current.add(event.clientY, event.timeStamp);
    },
    [disabled]
  );

  useEffect(() => {
    // Listening on the window rather than the element means a fast drag that
    // outruns the capture still reports every sample.
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
    };
  }, [onPointerMove, onPointerUp, onPointerCancel]);

  return { onPointerDown };
}
