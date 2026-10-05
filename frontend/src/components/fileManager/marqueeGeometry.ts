export interface SelectionBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface SelectionRow {
  start: number;
  end: number;
  size: number;
}

// Search the full layout, including rows the virtualizer has unmounted.
export function virtualSelectionIds(
  rect: SelectionBounds,
  rows: readonly SelectionRow[],
  ids: readonly string[],
  columns: number,
  width: number,
  margin: number,
  gap: number,
  measuredHeights: ReadonlyMap<string, number>,
  rowPadding = gap
): string[] {
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;
  const cardWidth = (width - gap * (columns - 1)) / columns;
  const result: string[] = [];
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (rows[mid]!.end - margin < rect.top) lo = mid + 1;
    else hi = mid;
  }
  for (let row = lo; row < rows.length; row++) {
    const measurement = rows[row]!;
    const top = measurement.start - margin;
    if (top > bottom) break;
    for (let col = 0; col < columns; col++) {
      const id = ids[row * columns + col];
      if (!id) break;
      const left = col * (cardWidth + gap);
      const height = measuredHeights.get(id) ?? measurement.size - rowPadding;
      if (left <= right && left + cardWidth >= rect.left && top + height >= rect.top) result.push(id);
    }
  }
  return result;
}
