import { useLayoutEffect, useRef } from 'react';
import type { Virtualizer } from '@tanstack/react-virtual';
import { virtualSelectionIds, type SelectionBounds } from '../marqueeGeometry';

export function useMarqueeGeometry(
  containerRef: React.RefObject<HTMLDivElement | null>,
  virtualizer: Virtualizer<HTMLElement, Element>,
  ids: string[],
  columns: number,
  width: number,
  margin: number,
  viewMode: 'grid' | 'list'
) {
  const heightsRef = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    heightsRef.current.clear();
  }, [columns, viewMode, width]);
  useLayoutEffect(() => {
    const validIds = new Set(ids);
    for (const id of heightsRef.current.keys()) {
      if (!validIds.has(id)) heightsRef.current.delete(id);
    }
  }, [ids]);
  return (rect: SelectionBounds) => {
    const container = containerRef.current;
    if (!container) return [];
    const row = container.querySelector<HTMLElement>('[data-index]');
    const style = row ? getComputedStyle(row) : null;
    const gap = viewMode === 'grid' ? parseFloat(style?.columnGap ?? '') || 0 : 0;
    const rowPadding = parseFloat(style?.paddingBottom ?? '') || 0;
    // Only mounted cards need DOM reads; remembered sizes survive unmounting.
    container.querySelectorAll<HTMLElement>('[data-file-id]').forEach(item => {
      const id = item.dataset.fileId;
      if (id) heightsRef.current.set(id, item.getBoundingClientRect().height);
    });
    return virtualSelectionIds(
      rect,
      virtualizer.measurementsCache,
      ids,
      columns,
      container.clientWidth,
      margin,
      gap,
      heightsRef.current,
      rowPadding
    );
  };
}
