import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { useApp } from '../contexts/AppContext';
import { isFileManagerPage, locationKey } from '../contexts/app/helpers';

/**
 * Browser-style scroll restoration for the main scroller.
 *
 * Each location's offset is recorded as the user scrolls. The jump waits until
 * the new location's listing has rendered, then lands before paint without
 * animating: the saved offset on back, forward or up, the top otherwise. Moving
 * any earlier would scroll the old listing while the next one is loading.
 */
export function useScrollRestoration(scrollerRef: RefObject<HTMLElement | null>) {
  const { currentPath, folderStack, listedLocation, navRestoresScroll } = useApp();
  const key = locationKey(currentPath, folderStack);
  // File pages keep showing the old listing until the new one arrives; other pages render at once.
  const ready = !isFileManagerPage(currentPath[0]) || listedLocation === key;
  const shownKeyRef = useRef(key);
  const offsetsRef = useRef(new Map<string, number>());

  useEffect(() => {
    // Recorded live, not on leaving: by the swap the browser has clamped scrollTop to the new content.
    // Captured on the document because the scroller mounts later when the layout switches.
    const record = (event: Event) => {
      const element = scrollerRef.current;
      if (element && event.target === element) offsetsRef.current.set(shownKeyRef.current, element.scrollTop);
    };
    document.addEventListener('scroll', record, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', record, { capture: true });
  }, [scrollerRef]);

  useLayoutEffect(() => {
    const element = scrollerRef.current;
    if (!element || !ready || shownKeyRef.current === key) return;
    shownKeyRef.current = key;
    element.scrollTop = navRestoresScroll ? (offsetsRef.current.get(key) ?? 0) : 0;
    // Listeners hear a scrollTop write a frame late; tell them now so the list virtualizer drops
    // the old listing's offset and pending scroll adjustment before it measures the new rows.
    element.dispatchEvent(new Event('scroll'));
  }, [key, ready, navRestoresScroll, scrollerRef]);
}
