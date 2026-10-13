export type ListView = 'rows' | 'skeleton' | 'error' | 'empty' | 'blank';

interface ListViewState {
  /** The delayed skeleton flag is on. */
  showSkeleton: boolean;
  listingFailed: boolean;
  isListingPending: boolean;
  isSearching: boolean;
  hasFiles: boolean;
}

/**
 * What the file list shows. "Empty" only once a listing for this folder has
 * arrived with nothing in it; before the skeleton appears, the previous
 * listing stays up rather than blanking the view.
 */
export function pickListView({
  showSkeleton,
  listingFailed,
  isListingPending,
  isSearching,
  hasFiles,
}: ListViewState): ListView {
  if (showSkeleton) return 'skeleton';
  if (listingFailed) return 'error';
  if (isListingPending) return hasFiles ? 'rows' : 'blank';
  if (hasFiles) return 'rows';
  return isSearching ? 'skeleton' : 'empty';
}
