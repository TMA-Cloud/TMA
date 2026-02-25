import React, { useEffect, useState } from 'react';
import { Modal } from '../ui/Modal';
import { useToast } from '../../hooks/useToast';
import { formatBytes } from '../../utils/storageUtils';
import { type FileItem, type FolderInfo, useApp } from '../../contexts/AppContext';
import { getDisplayFileName } from '../../utils/fileUtils';

interface FileInfoModalProps {
  isOpen: boolean;
  onClose: () => void;
  file: FileItem | null;
  currentPath: string[];
}

export const FileInfoModal: React.FC<FileInfoModalProps> = ({ isOpen, onClose, file, currentPath }) => {
  const { showToast } = useToast();
  const { hideFileExtensions } = useApp();
  const [infoItem, setInfoItem] = useState<FileItem | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen || !file) {
      return;
    }

    let cancelled = false;
    const fetchInfo = async () => {
      setLoading(true);
      setInfoItem(null);
      try {
        const res = await fetch(`/api/files/${file.id}/info`, {
          method: 'GET',
          credentials: 'include',
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          if (!cancelled) {
            showToast(text || 'Failed to load file info', 'error');
            setInfoItem(file);
          }
          return;
        }

        const apiData = await res.json();
        if (cancelled) return;

        const merged: FileItem = {
          ...file,
          ...apiData,
          modified: apiData.modified != null ? new Date(apiData.modified) : file.modified,
          deletedAt: apiData.deletedAt != null ? new Date(apiData.deletedAt) : file.deletedAt,
          expiresAt: apiData.expiresAt != null ? new Date(apiData.expiresAt) : (file.expiresAt ?? null),
        };
        setInfoItem(merged);
      } catch {
        if (!cancelled) {
          showToast('Failed to load file info', 'error');
          setInfoItem(file);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void fetchInfo();

    return () => {
      cancelled = true;
    };
  }, [file, isOpen, showToast]);

  const effectiveItem = infoItem || file;

  if (!isOpen || !effectiveItem) {
    return null;
  }

  const folderInfo: FolderInfo | undefined = effectiveItem.folderInfo;
  const hasFolderSize = folderInfo && typeof folderInfo.totalSize === 'number';
  const hasItemSize = effectiveItem.size != null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Get Info" size="sm">
      <div className="space-y-3 text-sm text-gray-700 dark:text-gray-200">
        {loading && <p className="text-xs text-gray-500 dark:text-gray-400">Loading latest info…</p>}
        <div>
          <p className="font-semibold">Name</p>
          <p className="mt-0.5 break-all">
            {getDisplayFileName(effectiveItem.name, effectiveItem.type === 'file', hideFileExtensions)}
          </p>
        </div>
        {(hasFolderSize || hasItemSize) && (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="font-semibold">Type</p>
              <p className="mt-0.5 capitalize">
                {String(effectiveItem.type || '').toLowerCase() === 'folder' ? 'Folder' : 'File'}
              </p>
            </div>
            <div>
              <p className="font-semibold">Size</p>
              <p className="mt-0.5">{formatBytes(folderInfo?.totalSize ?? effectiveItem.size)}</p>
            </div>
          </div>
        )}
        {String(effectiveItem.type || '').toLowerCase() === 'folder' && folderInfo && (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="font-semibold">Items in folder</p>
              <p className="mt-0.5">
                {folderInfo.fileCount} files, {folderInfo.folderCount} folders
              </p>
            </div>
          </div>
        )}
        <div>
          <p className="font-semibold">Location</p>
          <p className="mt-0.5 break-all">{['Home', ...currentPath.slice(1)].join(' / ')}</p>
        </div>
        <div className="grid grid-cols-1 gap-4">
          <div>
            <p className="font-semibold">Modified</p>
            <p className="mt-0.5">
              {effectiveItem.modified instanceof Date
                ? effectiveItem.modified.toLocaleString()
                : new Date(effectiveItem.modified).toLocaleString()}
            </p>
          </div>
        </div>
      </div>
    </Modal>
  );
};
