/**
 * Geometry shared by the two image viewers.
 *
 * The viewers themselves stay separate on purpose — the desktop one is built
 * around mouse drag and wheel zoom, the mobile one around pinch and swipe — but
 * both answer the same question after every zoom or pan: where is the image
 * allowed to sit? That answer is pure arithmetic.
 */

export interface Offset {
  x: number;
  y: number;
}

/**
 * Keep a scaled image inside its container.
 *
 * An axis smaller than the container is centred on that axis; an axis larger
 * than the container is clamped so its edges cannot be dragged inside the frame.
 *
 * @param offset       Current top-left offset of the scaled image.
 * @param containerW   Container width in px.
 * @param containerH   Container height in px.
 * @param contentW     Scaled image width in px.
 * @param contentH     Scaled image height in px.
 */
export function clampPan(
  offset: Offset,
  containerW: number,
  containerH: number,
  contentW: number,
  contentH: number
): Offset {
  const x =
    contentW <= containerW ? (containerW - contentW) / 2 : Math.max(containerW - contentW, Math.min(0, offset.x));

  const y =
    contentH <= containerH ? (containerH - contentH) / 2 : Math.max(containerH - contentH, Math.min(0, offset.y));

  return { x, y };
}
