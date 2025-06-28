import React, { useEffect, useRef } from "react";
import {
  Download,
  Edit3,
  Trash2,
  Share2,
  Star,
  Copy,
  Scissors,
  ClipboardPaste,
} from "lucide-react";
import { useApp } from "../../contexts/AppContext";

interface ContextMenuProps {
  isOpen: boolean;
  position: { x: number; y: number };
  onClose: () => void;
  selectedCount: number;
  targetId: string | null;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({
  isOpen,
  position,
  onClose,
  selectedCount,
  targetId,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const {
    selectedFiles,
    setClipboard,
    clipboard,
    pasteClipboard,
    folderStack,
    folderSharedStack,
    files,
    setRenameTarget,
    shareFiles,
    linkToParentShare,
    starFiles,
    deleteFiles,
    deleteForever,
    setShareLinkModalOpen,
    currentPath,
  } = useApp();

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    const handleEscKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleEscKey);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscKey);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const selectedItems = files.filter((f) => selectedFiles.includes(f.id));
  const allStarred =
    selectedItems.length > 0 && selectedItems.every((f) => f.starred);
  const allShared =
    selectedItems.length > 0 && selectedItems.every((f) => f.shared);
  const parentShared = folderSharedStack[folderSharedStack.length - 1];
  const allUnshared =
    selectedItems.length > 0 && selectedItems.every((f) => !f.shared);

  const menuItems = [
    { icon: Download, label: "Download", action: () => {} },
    ...(parentShared && allUnshared
      ? [
          {
            icon: Share2,
            label: "Link to Folder Share",
            action: async () => {
              const links = await linkToParentShare(selectedFiles);
              let base = import.meta.env.VITE_API_URL;
              if (base.endsWith("/api")) base = base.slice(0, -4);
              const list = Object.values(links).map((t) => `${base}/s/${t}`);
              if (list.length) setShareLinkModalOpen(true, list);
            },
          },
        ]
      : []),
    {
      icon: Share2,
      label: allShared ? "Remove from Shared" : "Add to Shared",
      action: async () => {
        const links = await shareFiles(selectedFiles, !allShared);
        if (!allShared) {
          let base = import.meta.env.VITE_API_URL;
          if (base.endsWith("/api")) base = base.slice(0, -4);
          const list = Object.values(links).map((t) => `${base}/s/${t}`);
          setShareLinkModalOpen(true, list);
        }
      },
    },
    {
      icon: Star,
      label: allStarred ? "Remove from Starred" : "Add to Starred",
      action: () => starFiles(selectedFiles, !allStarred),
    },
    {
      icon: Copy,
      label: "Copy",
      action: () => setClipboard({ ids: selectedFiles, action: "copy" }),
    },
    {
      icon: Scissors,
      label: "Cut",
      action: () => setClipboard({ ids: selectedFiles, action: "cut" }),
    },
    ...(clipboard
      ? [
          {
            icon: ClipboardPaste,
            label: "Paste",
            action: () =>
              pasteClipboard(targetId ?? folderStack[folderStack.length - 1]),
          },
        ]
      : []),
    {
      icon: Edit3,
      label: "Rename",
      action: () => {
        const id = targetId ?? selectedFiles[0];
        const file = files.find((f) => f.id === id);
        if (file) setRenameTarget(file);
      },
    },
    {
      icon: Trash2,
      label: currentPath[0] === "Trash" ? "Delete Forever" : "Delete",
      action: () =>
        currentPath[0] === "Trash"
          ? deleteForever(selectedFiles)
          : deleteFiles(selectedFiles),
      danger: true,
    },
  ];

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg py-2 min-w-48"
      style={{
        left: `${position.x}px`,
        top: `${position.y}px`,
      }}
    >
      <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          {selectedCount} item{selectedCount !== 1 ? "s" : ""} selected
        </p>
      </div>

      {menuItems.map((item, index) => {
        const Icon = item.icon;
        return (
          <button
            key={index}
            onClick={() => {
              item.action();
              onClose();
            }}
            className={`
              w-full flex items-center space-x-3 px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700
              ${
                item.danger
                  ? "text-red-600 dark:text-red-400"
                  : "text-gray-700 dark:text-gray-300"
              }
            `}
          >
            <Icon className="w-4 h-4" />
            <span className="text-sm">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
};
