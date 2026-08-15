/**
 * Cooperative scheduling helpers for work that would otherwise monopolise the
 * one thread the UI paints on.
 *
 * A loop over 50k files finishes in a few hundred milliseconds of pure compute,
 * but during those milliseconds nothing paints and no click is delivered, so
 * the app reads as frozen. The cure is not to make the loop faster: it is to
 * break it into slices short enough that the browser gets a turn between them.
 * Slices of roughly one frame keep the app answering input while the work runs
 * to completion in the background.
 */

/** A slice runs this long before handing control back — about one frame at 60Hz. */
const SLICE_BUDGET_MS = 12;

type SchedulerLike = {
  yield?: () => Promise<void>;
  postTask?: (callback: () => void, options?: { priority?: string }) => Promise<void>;
};

const getScheduler = (): SchedulerLike | undefined =>
  (globalThis as unknown as { scheduler?: SchedulerLike }).scheduler;

/**
 * Hands control back to the browser so it can paint and flush pending input,
 * then resumes.
 *
 * `scheduler.yield()` is the one to want: it resumes at the *front* of the task
 * queue, so slicing a job does not shove the rest of it behind every unrelated
 * timer that happened to be waiting. Without it, a MessageChannel message is
 * the cheapest way to schedule a genuine task — a microtask (queueMicrotask,
 * a bare await) will not do, because the renderer never runs between
 * microtasks. `setTimeout` is last because it is clamped to ~4ms and, once
 * nested, is deprioritised in background tabs.
 */
export function yieldToMain(): Promise<void> {
  const scheduler = getScheduler();
  if (typeof scheduler?.yield === 'function') {
    return scheduler.yield();
  }
  if (typeof MessageChannel === 'function') {
    return new Promise<void>(resolve => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        resolve();
      };
      channel.port2.postMessage(undefined);
    });
  }
  return new Promise<void>(resolve => setTimeout(resolve, 0));
}

/**
 * Tracks the current slice and reports when it has used its budget.
 *
 * Yielding on a fixed item count is a guess that goes wrong in both directions
 * — too often on a fast machine, not often enough on a slow one. Yielding on
 * elapsed time adapts to whatever the work and the device actually cost.
 */
export function createSliceBudget(budgetMs: number = SLICE_BUDGET_MS) {
  let sliceStart = performance.now();
  return {
    expired(): boolean {
      return performance.now() - sliceStart >= budgetMs;
    },
    reset(): void {
      sliceStart = performance.now();
    },
  };
}

/** Yields if the current slice is over budget. Returns true when it yielded. */
export async function yieldIfBudgetExpired(budget: ReturnType<typeof createSliceBudget>): Promise<boolean> {
  if (!budget.expired()) return false;
  await yieldToMain();
  budget.reset();
  return true;
}

/**
 * Maps over a list in time-sliced batches, yielding between slices.
 *
 * Use for transforms that are cheap per item but ruinous in bulk — the cost is
 * the length of the list, not the work on any one entry.
 */
export async function mapWithYield<T, R>(
  items: ArrayLike<T>,
  transform: (item: T, index: number) => R,
  onProgress?: (done: number, total: number) => void
): Promise<R[]> {
  const total = items.length;
  const result: R[] = new Array(total);
  const budget = createSliceBudget();

  for (let i = 0; i < total; i++) {
    result[i] = transform(items[i] as T, i);
    if (budget.expired()) {
      onProgress?.(i + 1, total);
      await yieldToMain();
      budget.reset();
    }
  }
  onProgress?.(total, total);
  return result;
}

/**
 * Runs tasks with a ceiling on how many are in flight, preserving result order.
 *
 * Firing every request at once does not make them finish sooner: the browser
 * caps connections per origin (six on HTTP/1.1), so the surplus just queues,
 * while the memory each pending request holds is charged immediately. A small
 * pool keeps the pipe full without the pile-up.
 */
export async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await task(items[index] as T, index);
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Wraps a callback so it fires at most once per interval, with the final call
 * always delivered.
 *
 * Upload progress arrives far faster than anyone can read it; re-rendering on
 * every event is how a progress bar ends up costing more than the transfer it
 * reports on.
 */
export function throttleTrailing<A extends unknown[]>(
  fn: (...args: A) => void,
  intervalMs: number
): (...args: A) => void {
  // Null rather than 0: the first call must go out at once, and a clock that
  // starts at zero (fake timers, a fresh worker) would otherwise look like a
  // call that just happened.
  let lastRun: number | null = null;
  let pendingArgs: A | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const run = (args: A) => {
    lastRun = performance.now();
    pendingArgs = null;
    fn(...args);
  };

  return (...args: A) => {
    const elapsed = lastRun === null ? Infinity : performance.now() - lastRun;
    if (elapsed >= intervalMs) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      run(args);
      return;
    }
    pendingArgs = args;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (pendingArgs) run(pendingArgs);
    }, intervalMs - elapsed);
  };
}
