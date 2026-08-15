/**
 * Coerce a progress value into a usable 0-100 percentage.
 *
 * Progress arrives from uploads, downloads and desktop handoffs, any of which
 * can report NaN or a stale out-of-range value mid-flight; every consumer wants
 * the same defensive clamp.
 */
export function clampPercent(value: number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}
