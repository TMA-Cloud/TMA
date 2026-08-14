import React from 'react';
import { FolderOpen, Search, Star, Share2, Trash2 } from 'lucide-react';

// Built once at module scope: these are fixed marks for each destination, not
// something the view decides on the fly.
const glyph = 'w-6 h-6 text-[var(--label-tertiary)]';
const GLYPHS = {
  search: <Search className={glyph} strokeWidth={1.75} />,
  starred: <Star className={glyph} strokeWidth={1.75} />,
  shared: <Share2 className={glyph} strokeWidth={1.75} />,
  trash: <Trash2 className={glyph} strokeWidth={1.75} />,
  folder: <FolderOpen className={glyph} strokeWidth={1.75} />,
};

interface EmptyStateProps {
  searchQuery: string;
  isSearching: boolean;
  currentPath: string[];
  canCreateFolder: boolean;
}

/**
 * An empty view still has to answer where you are and what you can do here —
 * the two questions a screen with nothing on it is worst at answering.
 */
export const EmptyState: React.FC<EmptyStateProps> = ({ searchQuery, isSearching, currentPath, canCreateFolder }) => {
  const searching = searchQuery.trim().length > 0;

  const getIcon = () => {
    if (searching) return GLYPHS.search;
    if (currentPath[0] === 'Starred') return GLYPHS.starred;
    if (currentPath[0] === 'Shared') return GLYPHS.shared;
    if (currentPath[0] === 'Trash') return GLYPHS.trash;
    return GLYPHS.folder;
  };

  const getTitle = () => {
    if (searching) {
      return isSearching ? 'Searching…' : 'No results';
    }
    if (currentPath[0] === 'Starred') return 'No starred files';
    if (currentPath[0] === 'Shared') return 'No shared files';
    if (currentPath[0] === 'Trash') return 'Trash is empty';
    return 'This folder is empty';
  };

  const getDescription = () => {
    if (searching) {
      return isSearching ? 'Looking through your files' : `Nothing matches “${searchQuery}”`;
    }
    if (currentPath[0] === 'Starred') return 'Star a file to find it again quickly';
    if (currentPath[0] === 'Shared') return 'Files others share with you show up here';
    if (currentPath[0] === 'Trash') return 'Deleted files wait here before they are gone for good';
    // `canCreateFolder` is false for members without the upload grant, so
    // pointing them at an upload they cannot perform would be misleading.
    return canCreateFolder ? 'Drop files anywhere here, or use Upload above' : 'Nothing has been added yet';
  };

  const isDropZoneContext = canCreateFolder && !searching;

  return (
    <div
      className={`
        flex flex-col items-center justify-center text-center select-none animate-fadeIn w-full
        ${
          isDropZoneContext
            ? 'min-h-[calc(100vh-18rem)] rounded-2xl border border-dashed border-[var(--separator-strong)]'
            : 'h-64'
        }
      `}
    >
      <div className="w-14 h-14 rounded-2xl bg-[var(--fill-quaternary)] grid place-items-center mb-4">{getIcon()}</div>
      <h3 className="type-title-3 text-[var(--label)]">{getTitle()}</h3>
      <p className="type-footnote text-[var(--label-tertiary)] mt-1.5 max-w-xs">{getDescription()}</p>
    </div>
  );
};
