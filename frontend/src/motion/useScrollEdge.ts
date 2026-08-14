import { useEffect, useRef, useState } from 'react';

/** How long after the last scroll event the overlay bar starts receding. */
const IDLE_MS = 900;

/**
 * Wires a scroll container to the two pieces of chrome that depend on it.
 *
 * `data-scrolled` drives the soft edge under a floating header. Ruling a 1px
 * line there permanently would draw a boundary that only exists while content
 * is actually passing beneath, so the edge fades in when it becomes true.
 *
 * `data-scrolling` drives the overlay scrollbar. The bar steps forward the
 * moment the user scrolls and recedes once they stop — present when it is
 * being used, quiet when it is not.
 *
 * Both are written straight to the DOM rather than through state, because
 * neither should cost the page a render while the user is mid-scroll.
 */
export function useScrollEdge<T extends HTMLElement>(threshold = 4) {
  const ref = useRef<T | null>(null);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    let frame = 0;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const read = () => {
      frame = 0;
      setScrolled(element.scrollTop > threshold);
    };

    const onScroll = () => {
      element.dataset.scrolling = 'true';
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        element.dataset.scrolling = 'false';
      }, IDLE_MS);

      // Coalesce to the display's clock; scroll fires far more often than the
      // screen can show a change.
      if (frame) return;
      frame = requestAnimationFrame(read);
    };

    read();
    element.dataset.scrolling = 'false';
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      element.removeEventListener('scroll', onScroll);
      clearTimeout(idleTimer);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [threshold]);

  return { ref, scrolled };
}
