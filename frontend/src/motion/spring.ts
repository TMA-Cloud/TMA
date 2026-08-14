/**
 * An interruptible, velocity-carrying spring.
 *
 * A fixed-duration animation cannot answer new input: once it starts, the only
 * thing it knows is where it was told to end. A spring can — retargeting it
 * only changes where it is heading, and it keeps the position and velocity it
 * already had. That is what lets a user grab something mid-flight and throw it
 * back the other way without hitting a wall.
 *
 * Parameterised the way a designer thinks about it rather than the way the
 * physics is written:
 *
 *   damping  — overshoot. 1 is critically damped: reaches the target and
 *              stops. Below 1 it overshoots and oscillates; lower is bouncier.
 *   response — how quickly the value reaches the target, in seconds. This is
 *              not a duration; a spring has no fixed duration, its settle time
 *              falls out of the parameters.
 *
 * Default to damping 1. Reserve bounce for motion a gesture actually threw —
 * overshoot on a menu that merely appeared feels wrong, overshoot on a card
 * you flicked feels right.
 */

export interface SpringConfig {
  /** Damping ratio. 1 = critically damped (no overshoot). ~0.8 = a little bounce. */
  damping?: number;
  /** Seconds for the value to reach its target. Lower is snappier. */
  response?: number;
}

export const SPRING_PRESETS = {
  /** Everyday UI. Graceful, never distracting. */
  default: { damping: 1, response: 0.35 },
  /** Repositioning something the user did not throw. */
  move: { damping: 1, response: 0.4 },
  /** Drawers and sheets — the gesture carried momentum, so a little bounce. */
  sheet: { damping: 0.82, response: 0.32 },
  /** Released after a flick. */
  momentum: { damping: 0.8, response: 0.4 },
  /** Snapping back from a boundary. */
  snap: { damping: 1, response: 0.28 },
} as const satisfies Record<string, Required<SpringConfig>>;

type Subscriber = (value: number, velocity: number) => void;

/** Every spring shares one rAF loop — the display's clock, not a timer. */
const running = new Set<Spring>();
let frameHandle: number | null = null;
let lastFrameTime = 0;

function tick(now: number) {
  frameHandle = null;
  // Cap the step so a backgrounded tab does not resume by teleporting.
  const dt = Math.min((now - lastFrameTime) / 1000, 1 / 20);
  lastFrameTime = now;

  for (const spring of running) {
    spring.advance(dt);
  }

  if (running.size > 0) schedule();
}

function schedule() {
  if (frameHandle !== null || typeof requestAnimationFrame === 'undefined') return;
  frameHandle = requestAnimationFrame(tick);
}

function join(spring: Spring) {
  if (running.size === 0) {
    lastFrameTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
  }
  running.add(spring);
  schedule();
}

export class Spring {
  private value: number;
  private velocity = 0;
  private target: number;
  private damping: number;
  private omega: number;
  private subscribers = new Set<Subscriber>();
  /** Precision the value has to reach before we call it settled. */
  private epsilon = 0.01;

  constructor(initial = 0, config: SpringConfig = {}) {
    this.value = initial;
    this.target = initial;
    this.damping = config.damping ?? SPRING_PRESETS.default.damping;
    this.omega = (2 * Math.PI) / (config.response ?? SPRING_PRESETS.default.response);
  }

  /** Reshape the spring without disturbing where it is or how fast it is going. */
  configure(config: SpringConfig) {
    if (config.damping !== undefined) this.damping = config.damping;
    if (config.response !== undefined) this.omega = (2 * Math.PI) / config.response;
    return this;
  }

  /** Scale of the values this spring carries, so `epsilon` means the same
   *  thing for a 0–1 progress value and a 900px offset. */
  setPrecision(epsilon: number) {
    this.epsilon = epsilon;
    return this;
  }

  get current() {
    return this.value;
  }

  get currentVelocity() {
    return this.velocity;
  }

  get isAnimating() {
    return running.has(this);
  }

  /**
   * Aim somewhere new. Position and velocity are untouched, so a reversal
   * blends through its existing motion instead of cutting to a fresh
   * animation — the cut is what reads as a brick wall.
   */
  setTarget(target: number, velocity?: number) {
    if (velocity !== undefined) this.velocity = velocity;
    this.target = target;
    if (!this.settled()) join(this);
    return this;
  }

  /** Teleport. Only for setting up state the user has not seen yet. */
  jump(value: number) {
    this.value = value;
    this.target = value;
    this.velocity = 0;
    running.delete(this);
    this.emit();
    return this;
  }

  /**
   * Drive the value directly, as during a drag. Velocity is supplied by the
   * gesture so that whatever animates next can pick it up exactly where the
   * finger left off.
   */
  track(value: number, velocity = 0) {
    running.delete(this);
    this.value = value;
    this.target = value;
    this.velocity = velocity;
    this.emit();
    return this;
  }

  /** Freeze wherever it is right now, keeping its velocity for a handoff. */
  hold() {
    running.delete(this);
    return this;
  }

  subscribe(fn: Subscriber) {
    this.subscribers.add(fn);
    fn(this.value, this.velocity);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  destroy() {
    running.delete(this);
    this.subscribers.clear();
  }

  private settled() {
    return Math.abs(this.target - this.value) < this.epsilon && Math.abs(this.velocity) < this.epsilon * 10;
  }

  private emit() {
    for (const fn of this.subscribers) fn(this.value, this.velocity);
  }

  /** @internal — stepped by the shared ticker. */
  advance(dt: number) {
    // Sub-step so a long frame cannot push the integrator unstable.
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;

    for (let i = 0; i < steps; i++) {
      const displacement = this.value - this.target;
      const acceleration = -this.omega * this.omega * displacement - 2 * this.damping * this.omega * this.velocity;
      this.velocity += acceleration * h;
      this.value += this.velocity * h;
    }

    if (this.settled()) {
      this.value = this.target;
      this.velocity = 0;
      running.delete(this);
      this.emit();
      return;
    }

    this.emit();
  }
}

/**
 * Two independent springs, one per axis.
 *
 * A single spring driving 2D distance desynchronises the moment the axes have
 * different velocities — the element curves when it should travel straight.
 */
export class Spring2D {
  readonly x: Spring;
  readonly y: Spring;

  constructor(x = 0, y = 0, config: SpringConfig = {}) {
    this.x = new Spring(x, config);
    this.y = new Spring(y, config);
  }

  configure(config: SpringConfig) {
    this.x.configure(config);
    this.y.configure(config);
    return this;
  }

  setTarget(x: number, y: number, vx?: number, vy?: number) {
    this.x.setTarget(x, vx);
    this.y.setTarget(y, vy);
    return this;
  }

  jump(x: number, y: number) {
    this.x.jump(x);
    this.y.jump(y);
    return this;
  }

  track(x: number, y: number, vx = 0, vy = 0) {
    this.x.track(x, vx);
    this.y.track(y, vy);
    return this;
  }

  subscribe(fn: (x: number, y: number) => void) {
    const emit = () => fn(this.x.current, this.y.current);
    const unsubX = this.x.subscribe(emit);
    const unsubY = this.y.subscribe(emit);
    return () => {
      unsubX();
      unsubY();
    };
  }

  destroy() {
    this.x.destroy();
    this.y.destroy();
  }
}
