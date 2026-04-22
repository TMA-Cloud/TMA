import { useEffect, useRef } from 'react';

/**
 * Returns a ref whose `current` is true while the component is mounted.
 * Use before setState in late callbacks (awaited promises, timers) to
 * prevent warnings about state updates after unmount.
 */
export function useIsMounted(): React.RefObject<boolean> {
  const ref = useRef(true);
  useEffect(() => {
    ref.current = true;
    return () => {
      ref.current = false;
    };
  }, []);
  return ref;
}
