// Recently listed folders, so going back to one shows it at once while it re-fetches.

import type { FileItem } from '../AppContext';

export interface CachedListing {
  files: FileItem[];
  nextCursor: string | null;
}

/** One listing is a location in one sort order; another order is a different first page. */
export const listingCacheKey = (location: string, sortBy: string, sortOrder: string) =>
  `${location}|${sortBy}|${sortOrder}`;

/** Least-recently-used map: a read moves the entry to the newest end. */
export function createListingCache(maxEntries = 30) {
  const entries = new Map<string, CachedListing>();

  return {
    get(key: string): CachedListing | undefined {
      const hit = entries.get(key);
      if (!hit) return undefined;
      entries.delete(key);
      entries.set(key, hit);
      return hit;
    },
    set(key: string, listing: CachedListing) {
      entries.delete(key);
      entries.set(key, listing);
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    /** Drops every entry but `key`, because a change seen here may have touched other folders too. */
    retainOnly(key: string) {
      for (const existing of [...entries.keys()]) {
        if (existing !== key) entries.delete(existing);
      }
    },
  };
}
