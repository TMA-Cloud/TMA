import React, { useState } from "react";
import { Modal } from "../ui/Modal";
import { useApp } from "../../contexts/AppContext";
import { Clipboard } from "lucide-react";
import { useToast } from "../../hooks/useToast";

export const ShareLinkModal: React.FC = () => {
  const { shareLinkModalOpen, shareLinks, setShareLinkModalOpen } = useApp();
  const { showToast } = useToast();
  const [copiedLink, setCopiedLink] = useState<string | null>(null);

  const handleClose = () => setShareLinkModalOpen(false);

  const copy = async (link: string) => {
    try {
      // Try modern clipboard API first
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(link);
      } else {
        // Fallback for older browsers
        const textArea = document.createElement("textarea");
        textArea.value = link;
        textArea.style.position = "fixed";
        textArea.style.left = "-999999px";
        textArea.style.top = "-999999px";
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        const successful = document.execCommand("copy");
        document.body.removeChild(textArea);
        if (!successful) {
          throw new Error("Copy command failed");
        }
      }
      setCopiedLink(link);
      showToast("Link copied to clipboard", "success");
      setTimeout(() => setCopiedLink(null), 2000);
    } catch {
      // Error handled by toast notification
      showToast("Failed to copy link", "error");
    }
  };

  if (!shareLinkModalOpen) return null;

  return (
    <Modal isOpen onClose={handleClose} title="Share Links">
      <div className="space-y-4">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Anyone with these links can download the files.
        </p>
        <div className="space-y-2">
          {shareLinks.map((link) => (
            <div key={link} className="flex items-center space-x-2">
              <input
                readOnly
                value={link}
                className="flex-1 px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-700 text-gray-700 dark:text-gray-200"
              />
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  copy(link);
                }}
                className="p-2 rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors"
                aria-label="Copy link to clipboard"
              >
                <Clipboard className="w-4 h-4" />
              </button>
              {copiedLink === link && (
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  Copied!
                </span>
              )}
            </div>
          ))}
        </div>
        <div className="flex justify-end">
          <button
            onClick={handleClose}
            className="px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors duration-200"
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
};
