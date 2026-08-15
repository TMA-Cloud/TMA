/**
 * Motion primitives.
 *
 * The rule the whole folder serves: motion starts from the value that is
 * currently on screen, inherits the user's velocity, projects that momentum
 * forward, and can be grabbed and reversed at any instant. Springs are what
 * make that possible — they are interruptible and velocity-aware by nature,
 * where a fixed-duration animation is neither.
 */

export { Spring, Spring2D, SPRING_PRESETS, type SpringConfig } from './spring';
export {
  project,
  projectedEndpoint,
  nearestSnapPoint,
  rubberband,
  rubberbandClamp,
  relativeVelocity,
  VelocityTracker,
} from './physics';
export { useSpring, useSpring2D, useSpringTransform } from './useSpring';
export { useDrag, type DragState, type DragOptions } from './useDrag';
export { usePress, type PressOptions } from './usePress';
export { useScrollEdge } from './useScrollEdge';
export { useReducedMotion, useReducedTransparency } from './useReducedMotion';
export { scrollToTopFast } from './scrollToTop';
