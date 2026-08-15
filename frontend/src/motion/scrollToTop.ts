/**
 * Return a scroll container to the top.
 *
 * An ease-out curve reads as deceleration into the top without the overshoot a
 * spring would add at the end of a long scroll.
 *
 * Both the desktop shell and the mobile shell scroll their main pane back to the
 * top on navigation.
 */

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

export function scrollToTopFast(el: HTMLElement, durationMs = 180) {
  // Respect reduced-motion preference
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
    el.scrollTo({ top: 0, behavior: 'auto' });
    return;
  }

  const startTop = el.scrollTop;
  if (startTop <= 0) return;

  const start = performance.now();
  const tick = (now: number) => {
    const t = Math.min(1, (now - start) / durationMs);
    const eased = easeOutCubic(t);
    el.scrollTop = Math.round(startTop * (1 - eased));
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
