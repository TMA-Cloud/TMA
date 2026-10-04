import { createReactComponent, type IconNode } from '@tabler/icons-react';

/**
 * Tabler draws a few format names (PDF, CSV, ZIP...) as 4x8 stroked letters on
 * its 24px grid, but not DOC, XLS, PPT, AI or PSD. These are set from Tabler's
 * own letter icons (MIT), squeezed into the same 4x8 cells so they match.
 */

/** Letter outlines from Tabler's `letter-*` icons, drawn in y 4..20. */
const LETTERS: Record<string, { paths: string[]; x0: number; x1: number }> = {
  A: { paths: ['M7 20v-12a4 4 0 0 1 4 -4h2a4 4 0 0 1 4 4v12', 'M7 13l10 0'], x0: 7, x1: 17 },
  C: { paths: ['M18 9a5 5 0 0 0 -5 -5h-2a5 5 0 0 0 -5 5v6a5 5 0 0 0 5 5h2a5 5 0 0 0 5 -5'], x0: 6, x1: 18 },
  D: { paths: ['M7 4h6a5 5 0 0 1 5 5v6a5 5 0 0 1 -5 5h-6v-16'], x0: 7, x1: 18 },
  I: { paths: ['M12 4l0 16'], x0: 12, x1: 12 },
  L: { paths: ['M7 4v16h10'], x0: 7, x1: 17 },
  O: { paths: ['M18 9a5 5 0 0 0 -5 -5h-2a5 5 0 0 0 -5 5v6a5 5 0 0 0 5 5h2a5 5 0 0 0 5 -5v-6'], x0: 6, x1: 18 },
  P: { paths: ['M7 20v-16h5.5a4 4 0 0 1 0 9h-5.5'], x0: 7, x1: 16.5 },
  S: { paths: ['M17 8a4 4 0 0 0 -4 -4h-2a4 4 0 0 0 0 8h2a4 4 0 0 1 0 8h-2a4 4 0 0 1 -4 -4'], x0: 7, x1: 17 },
  T: { paths: ['M6 4l12 0', 'M12 4l0 16'], x0: 6, x1: 18 },
  X: { paths: ['M7 4l10 16', 'M17 4l-10 16'], x0: 7, x1: 17 },
};

const CELL = 4;
const GAP = 3;

/** Path nodes for `text`, centred on the 24px grid in Tabler's 4x8 cells. */
export function formatLabelNode(text: string): IconNode {
  const width = text.length * CELL + (text.length - 1) * GAP;
  const start = 12 - width / 2;
  return [...text].flatMap((char, i) => {
    const letter = LETTERS[char];
    if (!letter) throw new Error(`No outline for "${char}"`);
    const cellX = start + i * (CELL + GAP);
    const span = letter.x1 - letter.x0;
    // A stem has no width to scale, so it sits in the middle of its cell.
    const sx = span ? CELL / span : 1;
    const tx = span ? cellX - sx * letter.x0 : cellX + CELL / 2 - letter.x0;
    const transform = `matrix(${+sx.toFixed(4)} 0 0 0.5 ${+tx.toFixed(4)} 6)`;
    return letter.paths.map((d, j) => ['path', { d, transform, key: `${char}${i}-${j}` }] as IconNode[number]);
  });
}

export const formatLabel = (text: string) =>
  createReactComponent('outline', `format-${text.toLowerCase()}`, `Format${text}`, formatLabelNode(text));
