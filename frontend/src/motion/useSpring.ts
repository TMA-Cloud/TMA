import { useEffect, useMemo, useRef } from 'react';
import { Spring, Spring2D, type SpringConfig } from './spring';
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

export function useSpring2D(x: number, y: number, config?: SpringConfig): Spring2D {
  const reducedMotion = useReducedMotion();
  const spring = useMemo(() => new Spring2D(x, y, config), []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (reducedMotion) {
      spring.configure({ damping: 1, response: 0.01 });
    } else if (config) {
      spring.configure(config);
    }
  }, [spring, reducedMotion, config?.damping, config?.response]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => spring.destroy(), [spring]);

  return spring;
}

/**
 * Bind a spring to a node, rendering it through a transform you supply.
 *
 * `will-change` goes on while motion is possible and comes off when the value
 * settles, so an idle screen is not holding a pile of compositor layers.
 */
export function useSpringTransform<T extends HTMLElement>(
  spring: Spring,
  toTransform: (value: number) => string,
  extra?: (element: T, value: number) => void
) {
  const ref = useRef<T | null>(null);
  const toTransformRef = useRef(toTransform);
  const extraRef = useRef(extra);

  useEffect(() => {
    toTransformRef.current = toTransform;
    extraRef.current = extra;
  });

  useEffect(() => {
    return spring.subscribe(value => {
      const element = ref.current;
      if (!element) return;
      element.style.transform = toTransformRef.current(value);
      extraRef.current?.(element, value);
    });
  }, [spring]);

  return ref;
}
