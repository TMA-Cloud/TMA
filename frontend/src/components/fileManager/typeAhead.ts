/** A pause longer than this starts a new search, close to Explorer's own window. */
export const TYPE_AHEAD_RESET_MS = 1000;

export interface TypeAheadBuffer {
  text: string;
  lastAt: number;
}

/** Case- and accent-insensitive form, so "e" finds "Été" and "É" finds "elephant". */
export function foldForTypeAhead(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
}

/** Appends `key` to the running search, or starts over after a pause. */
export function appendTypeAheadKey(prev: TypeAheadBuffer, key: string, now: number): TypeAheadBuffer {
  const expired = now - prev.lastAt > TYPE_AHEAD_RESET_MS;
  return { text: (expired ? '' : prev.text) + foldForTypeAhead(key), lastAt: now };
}

/**
 * Index of the item the search lands on, or -1 to keep the current one.
 * A fresh letter, or the same letter repeated ("aaa"), cycles to the next
 * match after the current item. A longer prefix ("rep") checks the current
 * item first, so typing more of its name doesn't jump away from it.
 */
export function findTypeAheadMatch(foldedNames: readonly string[], search: string, currentIndex: number): number {
  const count = foldedNames.length;
  if (!search || count === 0) return -1;

  const chars = [...search];
  const first = chars[0] ?? '';
  const cycling = chars.every(char => char === first);
  const prefix = cycling ? first : search;
  const start = cycling ? currentIndex + 1 : Math.max(currentIndex, 0);

  for (let offset = 0; offset < count; offset += 1) {
    const index = (((start + offset) % count) + count) % count;
    if (foldedNames[index]?.startsWith(prefix)) return index;
  }
  return -1;
}
