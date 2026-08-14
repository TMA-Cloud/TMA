import { useEffect, useState } from 'react';

function query(media: string): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(media).matches;
}

function useMediaPreference(media: string): boolean {
  const [matches, setMatches] = useState(() => query(media));

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    // The initial value comes from the lazy initialiser above; from here the
    // list itself is the source of truth.
    const list = window.matchMedia(media);
    const onChange = () => setMatches(list.matches);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [media]);

  return matches;
}

/**
 * Reduced motion does not mean no feedback — it means the non-vestibular
 * version of it. Components read this to swap travel and springs for a short
 * cross-fade while keeping the opacity and colour changes that explain what
 * just happened.
 */
export function useReducedMotion(): boolean {
  return useMediaPreference('(prefers-reduced-motion: reduce)');
}

/** Frostier surfaces: raise the opacity, drop the blur. */
export function useReducedTransparency(): boolean {
  return useMediaPreference('(prefers-reduced-transparency: reduce)');
}
