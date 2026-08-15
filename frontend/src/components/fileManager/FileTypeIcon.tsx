import React from 'react';
import { FileIcon, defaultStyles } from 'react-file-icon';
import { type FileItem } from '../../contexts/AppContext';
import { getExt } from '../../utils/fileUtils';

/**
 * Folder artwork, drawn to be told apart from a file at a glance rather than
 * by reading it:
 *
 * - Filled, not stroked. Below ~32px an outline's counters close up and the
 *   shape turns to mush; a solid mass keeps its edge all the way down.
 * - Landscape, so it is inset vertically (~76% of the box) and runs the full
 *   width. Matched to the page's bounding box instead it would carry more
 *   area than the files beside it and pull the eye down the column.
 */
const FolderGlyph: React.FC<{ className?: string }> = ({ className = '' }) => (
  <svg viewBox="0 0 32 32" className={className} aria-hidden="true" focusable="false">
    {/* Back panel and tab. */}
    <path
      d="M5 4.5h7.15a3 3 0 0 1 2.12.88L16.5 7.5H27a4 4 0 0 1 4 4V24a4 4 0 0 1-4 4H5a4 4 0 0 1-4-4V8.5a4 4 0 0 1 4-4z"
      fill="var(--folder-back)"
    />
    {/* Front flap, sitting a little proud of the back so the pocket reads. */}
    <path
      d="M3 11.25h26a2 2 0 0 1 2 2V24a4 4 0 0 1-4 4H5a4 4 0 0 1-4-4V13.25a2 2 0 0 1 2-2z"
      fill="var(--folder-front)"
    />
  </svg>
);

/**
 * Renders a file or folder icon. Files use react-file-icon's defaultStyles for
 * automatic extension → icon/color mapping; no manual mapping required.
 */
export const FileTypeIcon: React.FC<{
  file: FileItem;
  className?: string;
}> = ({ file, className = '' }) => {
  if (file.type === 'folder') {
    return (
      <div className={`flex items-center justify-center flex-shrink-0 ${className}`}>
        <FolderGlyph className="w-full h-full" />
      </div>
    );
  }

  const rawExt = getExt(file.name);
  const extension = rawExt ? rawExt.slice(1) : ''; // "pdf" from ".pdf"
  const style = extension && (defaultStyles as Record<string, object>)[extension];
  const fallback = { type: 'document' as const };
  const base = (style || fallback) as {
    type?: string;
    color?: string;
    labelColor?: string;
    [k: string]: unknown;
  };

  // Archive/compressed types: document-with-zipper look, clear label (zip, rar, 7z, etc.)
  const archiveStyle = {
    type: 'compressed',
    color: '#f3f3f0',
    labelColor: '#66645d',
    glyphColor: '#b0aea6',
    labelTextColor: '#FFFFFF',
  } as const;

  // Extension-specific styles so Windows/Mac/text/JSON get proper colored icons (not white)
  const extensionOverrides: Record<
    string,
    {
      type: string;
      color: string;
      labelColor: string;
      glyphColor: string;
      labelTextColor?: string;
    }
  > = {
    // Archives – consistent document + zipper + extension label
    zip: archiveStyle,
    zipx: archiveStyle,
    rar: archiveStyle,
    '7z': archiveStyle,
    '7zip': archiveStyle,
    tar: archiveStyle,
    gz: archiveStyle,
    gzip: archiveStyle,
    bz2: archiveStyle,
    xz: archiveStyle,
    lz: archiveStyle,
    lzma: archiveStyle,
    z: archiveStyle,
    // Disk images – drive icon with clear "iso" label
    iso: {
      type: 'drive',
      color: '#e8e7ff',
      labelColor: '#5e5ce6',
      glyphColor: '#7d7aff',
      labelTextColor: '#FFFFFF',
    },
    exe: {
      type: 'settings',
      color: '#0078D4',
      labelColor: '#106EBE',
      glyphColor: 'rgba(255,255,255,0.9)',
    },
    msi: {
      type: 'settings',
      color: '#0078D4',
      labelColor: '#106EBE',
      glyphColor: 'rgba(255,255,255,0.9)',
    },
    json: {
      type: 'document',
      color: '#ff9f0a',
      labelColor: '#c93400',
      glyphColor: 'rgba(255,255,255,0.9)',
    },
    txt: {
      type: 'document',
      color: '#8f8d85',
      labelColor: '#66645d',
      glyphColor: 'rgba(255,255,255,0.9)',
    },
    dmg: {
      type: 'drive',
      color: '#8f8d85',
      labelColor: '#66645d',
      glyphColor: 'rgba(255,255,255,0.9)',
    },
    pkg: {
      type: 'settings',
      color: '#8f8d85',
      labelColor: '#66645d',
      glyphColor: 'rgba(255,255,255,0.9)',
    },
  };

  // Type-based overrides for image and video (white → colored)
  const imageVideoOverrides: Record<string, { color: string; labelColor: string; glyphColor: string }> = {
    image: {
      color: '#af52de',
      labelColor: '#8944ab',
      glyphColor: 'rgba(255,255,255,0.9)',
    },
    video: {
      color: '#30b0c7',
      labelColor: '#20808f',
      glyphColor: 'rgba(255,255,255,0.9)',
    },
  };

  const extOverride = extension ? extensionOverrides[extension] : undefined;
  const typeOverride = base.type ? imageVideoOverrides[base.type] : undefined;
  const finalStyle = extOverride ? { ...base, ...extOverride } : typeOverride ? { ...base, ...typeOverride } : base;

  return (
    <div className={`flex items-center justify-center flex-shrink-0 ${className}`}>
      <FileIcon extension={extension || undefined} {...finalStyle} radius={8} />
    </div>
  );
};
