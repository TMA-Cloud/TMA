import { describe, expect, it } from 'vitest';

import { formatLabelNode } from '../../src/components/fileManager/formatLabel';

/** The x offset a node's transform places it at. */
const offsetX = (node: ReturnType<typeof formatLabelNode>[number]) => Number(node[1].transform!.split(' ')[4]);

describe('formatLabelNode', () => {
  it('draws one path per stroke of each letter', () => {
    // D, O and C are one stroke each; A and T are two.
    expect(formatLabelNode('DOC')).toHaveLength(3);
    expect(formatLabelNode('AI')).toHaveLength(3);
    expect(formatLabelNode('PPT')).toHaveLength(4);
  });

  it('sets letters on the cells Tabler uses for its own format names', () => {
    // Tabler's CSV starts its letters at x 3, 10 and 17; a stem-free first
    // letter lands exactly on the first cell.
    const [d] = formatLabelNode('DOC');
    expect(d![1].transform).toBe('matrix(0.3636 0 0 0.5 0.4545 6)');
    expect(0.3636 * 7 + offsetX(d!)).toBeCloseTo(3, 2);
  });

  it('centres shorter names on the grid', () => {
    const [aLeft] = formatLabelNode('AI');
    // Two cells and a gap are 11 wide, so the first starts at 6.5.
    expect(0.4 * 7 + offsetX(aLeft!)).toBeCloseTo(6.5, 3);
  });

  it('gives every path a distinct key', () => {
    const keys = formatLabelNode('PSD').map(([, attrs]) => attrs.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('refuses a letter it has no outline for', () => {
    expect(() => formatLabelNode('MP4')).toThrow('No outline for "M"');
  });
});
