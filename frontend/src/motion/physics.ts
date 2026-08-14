/**
 * The two pieces of physics a gesture needs after the finger leaves: where the
 * motion was heading, and what happens when it runs out of room.
 */

/**
 * Project where a flick would come to rest.
 *
 * Snapping to whatever is nearest the *release point* throws away the whole
 * gesture: a hard flick and a slow nudge that ended in the same place land in
 * the same spot. Projecting the momentum first is what makes a flick feel like
 * it threw the element.
 *
 * This is the exponential-decay form scroll views use — not the textbook
 * v²/(2a), which decelerates too abruptly to match anything else on screen.
 *
 * @param velocity px/s at the moment of release
 * @param decelerationRate 0.998 for normal scroll feel, 0.99 for snappier
 */
export function project(velocity: number, decelerationRate = 0.998): number {
  return ((velocity / 1000) * decelerationRate) / (1 - decelerationRate);
}

/** The point a flick from `position` would settle at. */
export function projectedEndpoint(position: number, velocity: number, decelerationRate = 0.998): number {
  return position + project(velocity, decelerationRate);
}

/** Whichever snap point the projected endpoint lands nearest. */
export function nearestSnapPoint(value: number, points: readonly number[]): number {
  let best = points[0] ?? value;
  let bestDistance = Math.abs(value - best);
  for (const point of points) {
    const distance = Math.abs(value - point);
    if (distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Resistance past a boundary.
 *
 * Stopping dead at an edge reads as frozen — the user cannot tell a limit from
 * a hang. Resisting progressively reads as responsive but empty: the surface
 * still answers the finger, it just gives less and less.
 *
 * @param overshoot how far past the bound the pointer has gone
 * @param dimension the size of the scrollable/draggable extent
 * @param constant lower is stiffer; 0.55 matches the platform feel
 */
export function rubberband(overshoot: number, dimension: number, constant = 0.55): number {
  if (dimension <= 0) return 0;
  return (overshoot * dimension * constant) / (dimension + constant * Math.abs(overshoot));
}

/** Clamp with rubber-banded give at both ends instead of a hard stop. */
export function rubberbandClamp(value: number, min: number, max: number, dimension: number, constant = 0.55): number {
  if (value < min) return min - rubberband(min - value, dimension, constant);
  if (value > max) return max + rubberband(value - max, dimension, constant);
  return value;
}

/**
 * Convert a gesture's px/s into the relative velocity some spring APIs want:
 * how many "remaining distances" per second the value is already covering.
 */
export function relativeVelocity(velocity: number, from: number, to: number): number {
  const distance = to - from;
  if (Math.abs(distance) < 1e-6) return 0;
  return velocity / distance;
}

/**
 * A short rolling history of pointer samples.
 *
 * Velocity from the last two events alone is noisy — one stuttered frame at
 * release and the throw comes out wrong. Measuring across a small window
 * smooths that out while still tracking a genuine change of direction.
 */
export class VelocityTracker {
  private samples: { value: number; time: number }[] = [];

  constructor(private windowMs = 100) {}

  add(value: number, time = performance.now()) {
    this.samples.push({ value, time });
    const cutoff = time - this.windowMs;
    while (this.samples.length > 2 && (this.samples[0]?.time ?? 0) < cutoff) {
      this.samples.shift();
    }
  }

  /** px/s across the window, 0 when there is nothing to measure. */
  get velocity(): number {
    if (this.samples.length < 2) return 0;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    if (!first || !last) return 0;
    const elapsed = last.time - first.time;
    if (elapsed <= 0) return 0;
    return ((last.value - first.value) / elapsed) * 1000;
  }

  reset() {
    this.samples = [];
  }
}
