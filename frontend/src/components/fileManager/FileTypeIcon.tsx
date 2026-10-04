import React from 'react';
import {
  AppWindow,
  CaseSensitive,
  CodeXml,
  Database,
  Image,
  Music,
  PenTool,
  Play,
  Presentation,
  Sheet,
  TextAlignJustify,
  TextAlignStart,
} from 'lucide-react';
import { IconCsv, IconJson, IconPdf, IconSql, IconSvg } from '@tabler/icons-react';
import { type FileItem } from '../../contexts/AppContext';
import { getFileKind, type FileKind } from '../../utils/fileKind';
import { getExt } from '../../utils/fileUtils';
import { ICON_STROKE } from '../ui/iconStroke';
import { formatLabel } from './formatLabel';

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
const FolderGlyph: React.FC<{ className?: string; children?: React.ReactNode }> = ({ className = '', children }) => (
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
    {children}
  </svg>
);

/**
 * An archive is a folder zipped shut, as the OS draws a compressed folder.
 * The pull is a solid block so it still reads once the teeth blur together.
 */
const ZipFolderGlyph: React.FC<{ className?: string }> = ({ className = '' }) => (
  <FolderGlyph className={className}>
    <g fill="var(--folder-zip)" data-kind="archive">
      {/* Teeth, staggered either side of the seam. */}
      <path d="M14.5 8h2v1.25h-2zM16 9.25h2v1.25h-2zM14.5 10.5h2v1.25h-2zM16 11.75h2V13h-2zM14.5 13h2v1.25h-2zM16 14.25h2v1.25h-2z" />
      {/* Slider and pull, with a slot cut through it. */}
      <path
        fillRule="evenodd"
        d="M15 15.5h2.5a1.25 1.25 0 0 1 1.25 1.25v5.5a1.25 1.25 0 0 1-1.25 1.25H15a1.25 1.25 0 0 1-1.25-1.25v-5.5A1.25 1.25 0 0 1 15 15.5zM16.25 18a.75.75 0 0 0-.75.75v1.75a.75.75 0 0 0 1.5 0v-1.75a.75.75 0 0 0-.75-.75z"
      />
    </g>
  </FolderGlyph>
);

type GlyphIcon = React.ComponentType<{
  x?: number;
  y?: number;
  size?: number;
  color?: string;
  fill?: string;
  strokeWidth?: number;
  'aria-hidden'?: 'true';
}>;

/**
 * A symbol, or a format name drawn as strokes. Lucide has the symbols; Tabler
 * fills in the format names Lucide lacks, on the same 24px grid and round caps.
 * Names are wider than a symbol, so they get the page's full width.
 */
interface Glyph {
  icon: GlyphIcon;
  label?: boolean;
  filled?: boolean;
}

const label = (icon: GlyphIcon): Glyph => ({ icon, label: true });

/**
 * Colour says which family a file is in; the glyph says it again for anyone
 * who can't tell the hues apart, so no two kinds share both. Kinds without a
 * colour of their own borrow the neutral one.
 */
const KIND_ART: Record<FileKind, { color: string; glyph?: Glyph }> = {
  document: { color: 'var(--file-document)', glyph: { icon: TextAlignJustify } },
  pdf: { color: 'var(--file-pdf)', glyph: label(IconPdf) },
  spreadsheet: { color: 'var(--file-spreadsheet)', glyph: { icon: Sheet } },
  presentation: { color: 'var(--file-presentation)', glyph: { icon: Presentation } },
  image: { color: 'var(--file-image)', glyph: { icon: Image } },
  design: { color: 'var(--file-design)', glyph: { icon: PenTool } },
  video: { color: 'var(--file-video)', glyph: { icon: Play, filled: true } },
  audio: { color: 'var(--file-audio)', glyph: { icon: Music } },
  archive: { color: 'var(--file-archive)' },
  code: { color: 'var(--file-code)', glyph: { icon: CodeXml } },
  database: { color: 'var(--file-database)', glyph: { icon: Database } },
  text: { color: 'var(--file-text)', glyph: { icon: TextAlignStart } },
  executable: { color: 'var(--file-executable)', glyph: { icon: AppWindow } },
  font: { color: 'var(--file-generic)', glyph: { icon: CaseSensitive } },
  generic: { color: 'var(--file-generic)' },
};

const DOC = label(formatLabel('DOC'));
const XLS = label(formatLabel('XLS'));
const PPT = label(formatLabel('PPT'));
const PSD = label(formatLabel('PSD'));

/** Formats people know by name, where the name says more than the kind's symbol. */
const EXTENSION_GLYPHS: Record<string, Glyph> = {
  '.doc': DOC,
  '.docx': DOC,
  '.xls': XLS,
  '.xlsx': XLS,
  '.ppt': PPT,
  '.pptx': PPT,
  '.ai': label(formatLabel('AI')),
  '.psd': PSD,
  '.psb': PSD,
  '.csv': label(IconCsv),
  '.sql': label(IconSql),
  '.json': label(IconJson),
  '.svg': label(IconSvg),
};

/**
 * A flat, filled page in the folder's grid, so files and folders read as one
 * family. Portrait and full height, which gives it about the folder's area.
 * The fold is a lighter flap rather than a shadow, which keeps it flat.
 */
const PageGlyph: React.FC<{ kind: FileKind; ext: string; className?: string }> = ({ kind, ext, className = '' }) => {
  const { color, glyph: kindGlyph } = KIND_ART[kind];
  const glyph = EXTENSION_GLYPHS[ext] ?? kindGlyph;
  const Icon = glyph?.icon;
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true" focusable="false" data-kind={kind}>
      <path
        d="M8.5 2H19l8 8v16.5a3.5 3.5 0 0 1-3.5 3.5h-15A3.5 3.5 0 0 1 5 26.5v-21A3.5 3.5 0 0 1 8.5 2z"
        fill={color}
      />
      <path d="M19 2l8 8h-5a3 3 0 0 1-3-3z" fill="var(--file-glyph)" fillOpacity={0.4} />
      {Icon && (
        <Icon
          {...(glyph.label ? { x: 6, y: 10, size: 20 } : { x: 9, y: 13, size: 14 })}
          color="var(--file-glyph)"
          fill={glyph.filled ? 'var(--file-glyph)' : 'none'}
          strokeWidth={ICON_STROKE}
          aria-hidden="true"
        />
      )}
    </svg>
  );
};

/** Renders a file or folder icon, picking file artwork from its kind. */
export const FileTypeIcon: React.FC<{
  file: FileItem;
  className?: string;
}> = ({ file, className = '' }) => {
  const kind = file.type === 'folder' ? null : getFileKind(file.name, file.mimeType);
  return (
    <div className={`flex items-center justify-center flex-shrink-0 ${className}`}>
      {kind === null ? (
        <FolderGlyph className="w-full h-full" />
      ) : kind === 'archive' ? (
        <ZipFolderGlyph className="w-full h-full" />
      ) : (
        <PageGlyph kind={kind} ext={getExt(file.name)} className="w-full h-full" />
      )}
    </div>
  );
};
