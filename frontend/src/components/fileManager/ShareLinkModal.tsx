import React, { useState } from "react";
import { Modal } from "../ui/Modal";
import { useApp, type ShareExpiry } from "../../contexts/AppContext";
import { Clipboard, Check, Clock } from "lucide-react";
import { useToast } from "../../hooks/useToast";

const EXPIRY_OPTIONS: { value: ShareExpiry; label: string }[] = [
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "never", label: "No expiration" },
];

export const ShareLinkModal: React.FC = () => {
  const { shareLinkModalOpen, shareLinks, setShareLinkModalOpen } = useApp();
  const { showToast } = useToast();
  const [copiedLink, setCopiedLink] = useState<string | null>(null);

  const handleClose = () => setShareLinkModalOpen(false);

  const copy = async (link: string) => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(link);
      } else {
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
                className={`p-2 rounded-lg transition-colors ${
                  copiedLink === link
                    ? "bg-green-500 text-white"
                    : "bg-blue-500 hover:bg-blue-600 text-white"
                }`}
                aria-label="Copy link to clipboard"
              >
                {copiedLink === link ? (
                  <Check className="w-4 h-4" />
                ) : (
                  <Clipboard className="w-4 h-4" />
                )}
              </button>
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

/**
 * Modal shown before sharing — lets the user pick an expiry duration.
 * Calls onConfirm(expiry) when the user proceeds.
 */
export const ShareExpiryModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (expiry: ShareExpiry) => void;
  fileCount: number;
}> = ({ isOpen, onClose, onConfirm, fileCount }) => {
  const [expiry, setExpiry] = useState<ShareExpiry>("7d");

  if (!isOpen) return null;

  return (
    <Modal isOpen onClose={onClose} title="Share Options" size="sm">
      <div className="space-y-5">
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Choose how long the link stays active for{" "}
          <span className="font-medium text-gray-800 dark:text-gray-200">
            {fileCount} item{fileCount !== 1 ? "s" : ""}
          </span>
          .
        </p>

        <div className="space-y-2">
          {EXPIRY_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setExpiry(opt.value)}
              className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border transition-all duration-200 text-left ${
                expiry === opt.value
                  ? "border-blue-500 bg-blue-50 dark:bg-blue-900/30 dark:border-blue-400 ring-1 ring-blue-500/20"
                  : "border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600"
              }`}
            >
              <Clock
                className={`w-4 h-4 flex-shrink-0 ${
                  expiry === opt.value
                    ? "text-blue-600 dark:text-blue-400"
                    : "text-gray-400 dark:text-gray-500"
                }`}
              />
              <span
                className={`text-sm font-medium ${
                  expiry === opt.value
                    ? "text-blue-700 dark:text-blue-300"
                    : "text-gray-700 dark:text-gray-300"
                }`}
              >
                {opt.label}
              </span>
            </button>
          ))}
        </div>

        <div className="flex justify-end space-x-3 pt-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors duration-200"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(expiry)}
            className="px-4 py-2 rounded-lg text-white bg-blue-500 hover:bg-blue-600 transition-colors duration-200"
          >
            Share
          </button>
        </div>
      </div>
    </Modal>
  );
};
