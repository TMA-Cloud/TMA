import React, { type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// First tooltip in a run waits; once one is up, moving along a toolbar skips it.
const OPEN_DELAY = 450;
const GROUP_WINDOW = 800;

// Gap to the anchor, and min clearance from any viewport edge before flip/clamp.
const GAP = 8;
const MARGIN = 8;

let lastShownAt = 0;

interface TooltipProps {
  text: string;
  children: ReactNode;
}

interface Position {
  left: number;
  top: number;
  placement: 'top' | 'bottom';
}

// Portaled to document.body with fixed positioning so it escapes every
// overflow/sticky/stacking ancestor (a sticky toolbar would otherwise shear it).
export const Tooltip: React.FC<TooltipProps> = ({ text, children }) => {
  // mounted keeps it in the DOM through the fade-out; visible drives opacity/scale.
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState<Position | null>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const openTimer = useRef<number | null>(null);
  const unmountTimer = useRef<number | null>(null);

  const clearTimers = useCallback(() => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    if (unmountTimer.current !== null) window.clearTimeout(unmountTimer.current);
    openTimer.current = null;
    unmountTimer.current = null;
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  // Measure anchor + bubble, pick a side, clamp to the viewport. Re-runs on
  // scroll/resize so it tracks the anchor rather than drifting.
  const place = useCallback(() => {
    const anchor = anchorRef.current?.getBoundingClientRect();
    const bubble = bubbleRef.current;
    if (!anchor || !bubble) return;

    const { width: bw, height: bh } = bubble.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;

    // Prefer above; flip below only when above clips and below fits.
    const roomAbove = anchor.top;
    const roomBelow = vh - anchor.bottom;
    const needed = bh + GAP + MARGIN;
    const placement: 'top' | 'bottom' = roomAbove >= needed || roomAbove >= roomBelow ? 'top' : 'bottom';

    const top = placement === 'top' ? anchor.top - GAP - bh : anchor.bottom + GAP;

    const centre = anchor.left + anchor.width / 2;
    const left = Math.min(Math.max(centre - bw / 2, MARGIN), vw - MARGIN - bw);

    setPos({ left, top, placement });
  }, []);

  const show = useCallback(
    (immediate: boolean) => {
      clearTimers();
      const open = () => {
        setMounted(true);
        lastShownAt = Date.now();
      };
      if (immediate || Date.now() - lastShownAt < GROUP_WINDOW) {
        open();
        return;
      }
      openTimer.current = window.setTimeout(open, OPEN_DELAY);
    },
    [clearTimers]
  );

  const hide = useCallback(() => {
    clearTimers();
    if (visible) lastShownAt = Date.now();
    setVisible(false);
    // Stay mounted through the fade-out (~150ms transition).
    unmountTimer.current = window.setTimeout(() => {
      setMounted(false);
      setPos(null);
    }, 180);
  }, [clearTimers, visible]);

  // Once measurable: place, reveal, and keep it pinned while up.
  useLayoutEffect(() => {
    if (!mounted) return;
    place();
    const raf = requestAnimationFrame(() => setVisible(true));
    const onMove = () => place();
    window.addEventListener('scroll', onMove, true);
    window.addEventListener('resize', onMove);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onMove, true);
      window.removeEventListener('resize', onMove);
    };
  }, [mounted, place]);

  return (
    <span
      ref={anchorRef}
      className="relative inline-block"
      onMouseEnter={() => show(false)}
      onMouseLeave={hide}
      // Keyboard focus is a commitment — no delay.
      onFocus={() => show(true)}
      onBlur={hide}
    >
      {children}
      {mounted &&
        createPortal(
          // Hidden during drag via body.is-dragging (see index.css).
          <span
            ref={bubbleRef}
            className={`
              pointer-events-none fixed z-[1000] whitespace-nowrap
              ${pos?.placement === 'bottom' ? 'origin-top' : 'origin-bottom'}
              px-2.5 py-1.5 rounded-lg type-caption vibrant
              material-thick material-edge text-[var(--label)]
              transition-motion duration-150 ease-[cubic-bezier(0.22,1,0.36,1)]
              ${visible && pos ? 'opacity-100 scale-100' : 'opacity-0 scale-90 material-hidden'}
              max-w-xs truncate
              drag-hide-tooltip
            `}
            style={{ left: pos?.left ?? 0, top: pos?.top ?? 0 }}
            role="tooltip"
            aria-hidden={!visible}
          >
            {text}
          </span>,
          document.body
        )}
    </span>
  );
};
