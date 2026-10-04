export type MoveKey = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End' | 'PageUp' | 'PageDown';

const MOVE_KEYS: ReadonlySet<string> = new Set<MoveKey>([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

export function isMoveKey(key: string): key is MoveKey {
  return MOVE_KEYS.has(key);
}

/** Moves whole rows and keeps the column; a short last row clamps to its final item. */
function moveByRows(from: number, rows: number, count: number, columns: number): number {
  const lastRow = Math.floor((count - 1) / columns);
  const row = Math.floor(from / columns);
  const targetRow = Math.min(Math.max(row + rows, 0), lastRow);
  if (targetRow === row) return from;
  return Math.min(targetRow * columns + (from % columns), count - 1);
}

/**
 * Index the focus lands on, following Explorer: arrows step through a
 * grid of `columns` (1 in list view), Page keys jump `pageRows` rows, and
 * with nothing focused yet every key but End starts at the first item.
 */
export function moveIndex(key: MoveKey, from: number, count: number, columns: number, pageRows: number): number {
  if (count === 0) return -1;
  if (key === 'End') return count - 1;
  if (from < 0 || from >= count || key === 'Home') return 0;

  switch (key) {
    case 'ArrowLeft':
      return Math.max(from - 1, 0);
    case 'ArrowRight':
      return Math.min(from + 1, count - 1);
    case 'ArrowUp':
      return moveByRows(from, -1, count, columns);
    case 'ArrowDown':
      return moveByRows(from, 1, count, columns);
    case 'PageUp':
      return moveByRows(from, -pageRows, count, columns);
    case 'PageDown':
      return moveByRows(from, pageRows, count, columns);
  }
}

/** Ids from `anchor` to `focus` inclusive, ending on the focus so it reads as the current item. */
export function rangeIds(ids: readonly string[], anchor: number, focus: number): string[] {
  const step = focus >= anchor ? 1 : -1;
  const range: string[] = [];
  for (let i = anchor; i !== focus + step; i += step) {
    const id = ids[i];
    if (id !== undefined) range.push(id);
  }
  return range;
}
