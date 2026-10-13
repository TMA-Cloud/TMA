import { useEffect, useRef, useState } from 'react';

/**
 * Follows `active`, but turns on only after `delayMs` and then stays on for at
 * least `minVisibleMs`. A quick load never flashes a placeholder, and a slow
 * one doesn't blink it away a moment after it appeared.
 */
export function useDelayedFlag(active: boolean, delayMs = 200, minVisibleMs = 400): boolean {
  const [visible, setVisible] = useState(false);
  const shownAtRef = useRef(0);

  useEffect(() => {
    if (active && !visible) {
      const timer = setTimeout(() => {
        shownAtRef.current = Date.now();
        setVisible(true);
      }, delayMs);
      return () => clearTimeout(timer);
    }
    if (!active && visible) {
      const remaining = minVisibleMs - (Date.now() - shownAtRef.current);
      const timer = setTimeout(() => setVisible(false), Math.max(0, remaining));
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [active, visible, delayMs, minVisibleMs]);

  return visible;
}
