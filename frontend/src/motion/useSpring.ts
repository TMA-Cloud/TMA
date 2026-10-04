import { useEffect, useMemo } from 'react';
import { Spring, type SpringConfig } from './spring';
import { useReducedMotion } from './useReducedMotion';

/**
 * A spring wired straight to the DOM.
 *
 * The value never passes through React state: a re-render per frame is the
 * kind of latency that makes direct manipulation fall apart. The subscriber
 * writes to the node, and only compositor-friendly properties should be
 * written from it.
 */
export function useSpring(initial: number, config?: SpringConfig): Spring {
  const reducedMotion = useReducedMotion();
  const spring = useMemo(() => new Spring(initial, config), []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // With reduced motion the spring still runs, it just arrives immediately —
    // callers stay on one code path and nothing has to branch mid-gesture.
    if (reducedMotion) {
      spring.configure({ damping: 1, response: 0.01 });
    } else if (config) {
      spring.configure(config);
    }
  }, [spring, reducedMotion, config?.damping, config?.response]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => spring.destroy(), [spring]);

  return spring;
}
