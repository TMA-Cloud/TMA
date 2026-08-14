import React, { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

/**
 * Delay before the first tooltip in a run appears. Once one is up, moving
 * along a toolbar should not re-pay it — a disambiguation delay is only worth
 * charging the user once.
 */
const OPEN_DELAY = 450;
const GROUP_WINDOW = 800;

let lastShownAt = 0;

interface TooltipProps {
  text: string;
  children: ReactNode;
}

export const Tooltip: React.FC<TooltipProps> = ({ text, children }) => {
  const [visible, setVisible] = useState(false);
  const [placement, setPlacement] = useState<'top' | 'bottom'>('top');
  const anchorRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<number | null>(null);

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => clear, [clear]);

  const show = useCallback(
    (immediate: boolean) => {
      clear();
      const open = () => {
        // Flip below when there is no room above, so the label never lands
        // off-screen where the control it explains cannot be seen either.
        const bounds = anchorRef.current?.getBoundingClientRect();
        setPlacement(bounds && bounds.top < 56 ? 'bottom' : 'top');
        setVisible(true);
        lastShownAt = Date.now();
      };

      if (immediate || Date.now() - lastShownAt < GROUP_WINDOW) {
        open();
        return;
      }
      timerRef.current = window.setTimeout(open, OPEN_DELAY);
    },
    [clear]
  );

  const hide = useCallback(() => {
    clear();
    if (visible) lastShownAt = Date.now();
    setVisible(false);
  }, [clear, visible]);

  return (
    <span
      ref={anchorRef}
      className="relative inline-block"
      onMouseEnter={() => show(false)}
      onMouseLeave={hide}
      // Keyboard users have already committed to the control, so there is
      // nothing to disambiguate and nothing to wait for.
      onFocus={() => show(true)}
      onBlur={hide}
    >
      {children}
      {/* Hidden during drag via .is-dragging class on document.body (set by FileManager) */}
      <span
        className={`
          pointer-events-none absolute left-1/2 -translate-x-1/2 z-50 whitespace-nowrap
          ${placement === 'top' ? 'bottom-full mb-2 origin-bottom' : 'top-full mt-2 origin-top'}
          px-2.5 py-1.5 rounded-lg type-caption vibrant
          material-thick material-edge text-[var(--label)]
          transition-motion duration-150 ease-[cubic-bezier(0.22,1,0.36,1)]
          ${visible ? 'opacity-100 scale-100' : 'opacity-0 scale-90'}
          max-w-xs truncate
          drag-hide-tooltip
        `}
        role="tooltip"
        aria-hidden={!visible}
      >
        {text}
      </span>
    </span>
  );
};
