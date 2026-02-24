import React from 'react';
import { FileIcon, defaultStyles } from 'react-file-icon';
import { Folder } from 'lucide-react';
import { type FileItem } from '../../contexts/AppContext';
import { getExt } from '../../utils/fileUtils';

/**
 * Renders a file or folder icon in a rounded colored square (like the reference style).
 * Uses react-file-icon's defaultStyles for automatic extension → icon/color mapping;
 * no manual mapping required.
 */
export const FileTypeIcon: React.FC<{
  file: FileItem;
  className?: string;
}> = ({ file, className = '' }) => {
  if (file.type === 'folder') {
    return (
      <div
        className={`flex items-center justify-center rounded-xl flex-shrink-0 ${className}`}
        style={{
          backgroundColor: '#E6B422',
          color: 'white',
          boxShadow: '0 1px 2px rgba(0,0,0,0.08)',
        }}
      >
        <Folder className="w-[55%] h-[55%]" strokeWidth={2} />
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
    color: '#F1F5F9',
    labelColor: '#475569',
    glyphColor: '#94A3B8',
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
      color: '#E0E7FF',
      labelColor: '#4F46E5',
      glyphColor: '#6366F1',
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
      color: '#F59E0B',
      labelColor: '#D97706',
      glyphColor: 'rgba(255,255,255,0.9)',
    },
    txt: {
      type: 'document',
      color: '#64748B',
      labelColor: '#475569',
      glyphColor: 'rgba(255,255,255,0.9)',
    },
    dmg: {
      type: 'drive',
      color: '#6B7280',
      labelColor: '#4B5563',
      glyphColor: 'rgba(255,255,255,0.9)',
    },
    pkg: {
      type: 'settings',
      color: '#6B7280',
      labelColor: '#4B5563',
      glyphColor: 'rgba(255,255,255,0.9)',
    },
  };

  // Type-based overrides for image and video (white → colored)
  const imageVideoOverrides: Record<string, { color: string; labelColor: string; glyphColor: string }> = {
    image: {
      color: '#7C3AED',
      labelColor: '#5B21B6',
      glyphColor: 'rgba(255,255,255,0.9)',
    },
    video: {
      color: '#0D9488',
      labelColor: '#0F766E',
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
