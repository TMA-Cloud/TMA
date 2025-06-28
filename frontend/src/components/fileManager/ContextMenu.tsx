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
    files,
    setRenameTarget,
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

  const menuItems = [
    { icon: Download, label: "Download", action: () => {} },
    { icon: Share2, label: "Share", action: () => {} },
    { icon: Star, label: "Add to Starred", action: () => {} },
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
    { icon: Trash2, label: "Delete", action: () => {}, danger: true },
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
