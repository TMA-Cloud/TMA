import React from 'react';
import { createPortal } from 'react-dom';
import { useIsMobile } from '../../hooks/useIsMobile';
import { Modal } from '../ui/Modal';
import { ShareExpiryModal } from './ShareLinkModal';
import { FileInfoModal } from './FileInfoModal';
import { useContextMenuActions } from './hooks/useContextMenuActions';
import { useContextMenuNavigation } from './hooks/useContextMenuNavigation';

interface ContextMenuProps {
  isOpen: boolean;
  position: { x: number; y: number };
  onClose: () => void;
  selectedCount: number;
  targetId: string | null;
  multiSelectMode?: boolean;
  setMultiSelectMode?: (enabled: boolean) => void;
  onActionComplete?: () => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({
  isOpen,
  position,
  onClose,
  selectedCount,
  targetId,
  multiSelectMode = false,
  setMultiSelectMode,
  onActionComplete,
}) => {
  const isMobile = useIsMobile();

  const {
    menuItems,
    confirmModalOpen,
    setConfirmModalOpen,
    pendingAction,
    setPendingAction,
    handleConfirmDelete,
    confirmationTitle,
    confirmationMessage,
    isDeleting,
    shareExpiryOpen,
    setShareExpiryOpen,
    handleShareExpiry,
    selectedFilesCount,
    infoOpen,
    setInfoOpen,
    infoFile,
    currentPath,
  } = useContextMenuActions({ targetId, isMobile, multiSelectMode, setMultiSelectMode, onClose, onActionComplete });

  const { menuRef, menuStyle, menuVisible, focusedIndex, setFocusedIndex } = useContextMenuNavigation({
    isOpen,
    isMobile,
    position,
    menuItems,
    onClose,
  });

  // Render modal outside of isOpen check so it persists when context menu closes
  const modalElement = (
    <Modal
      isOpen={confirmModalOpen}
      onClose={() => {
        setConfirmModalOpen(false);
        setPendingAction(null);
      }}
      title={confirmationTitle}
      size="sm"
    >
      <div className="space-y-4">
        <p className="text-gray-700 dark:text-gray-300">{confirmationMessage}</p>
        <div className="flex justify-end space-x-3 pt-4">
          <button
            onClick={() => {
              setConfirmModalOpen(false);
              setPendingAction(null);
            }}
            className="px-4 py-2 rounded-lg text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors duration-200"
          >
            Cancel
          </button>
          <button
            onClick={handleConfirmDelete}
            disabled={isDeleting}
            className="px-4 py-2 rounded-lg text-white bg-red-600 hover:bg-red-700 dark:bg-red-500 dark:hover:bg-red-600 transition-colors duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isDeleting ? 'Deleting...' : pendingAction?.type === 'deleteForever' ? 'Delete Forever' : 'Delete'}
          </button>
        </div>
      </div>
    </Modal>
  );

  const shareExpiryElement = (
    <ShareExpiryModal
      isOpen={shareExpiryOpen}
      onClose={() => setShareExpiryOpen(false)}
      onConfirm={handleShareExpiry}
      fileCount={selectedFilesCount}
    />
  );

  if (!isOpen) {
    // Still render modals even when context menu is closed
    return (
      <>
        {modalElement}
        {shareExpiryElement}
        <FileInfoModal isOpen={infoOpen} onClose={() => setInfoOpen(false)} file={infoFile} currentPath={currentPath} />
      </>
    );
  }

  // Mobile: bottom sheet with overlay
  if (isMobile) {
    return (
      <>
        <div
          className="fixed inset-0 z-50 flex flex-col justify-end bg-black/20 dark:bg-black/40 backdrop-blur-sm animate-fadeIn"
          role="dialog"
          aria-modal="true"
          onClick={onClose}
        >
          <div
            ref={menuRef}
            className="material-thick material-edge scroller rounded-t-3xl pt-3 pb-4 px-4 max-h-[70vh] overflow-y-auto animate-slideUp"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-center mb-3">
              <div className="h-1 w-10 rounded-full bg-gray-300/50 dark:bg-gray-700/50" />
            </div>
            <div className="mb-3 text-center">
              <p className="text-xs font-medium text-gray-500/80 dark:text-gray-400/80">
                {selectedCount} item{selectedCount !== 1 ? 's' : ''} selected
              </p>
            </div>
            <div className="space-y-1">
              {menuItems.map((item, index) => {
                const Icon = item.icon;
                return (
                  <button
                    key={index}
                    onClick={() => {
                      if (!item.disabled) {
                        item.action();
                        onClose();
                      }
                    }}
                    className={`
                      w-full flex items-center justify-between px-4 py-3 rounded-lg
                      text-sm transition-all duration-200
                      ${
                        item.disabled
                          ? 'opacity-50 cursor-not-allowed text-gray-400 dark:text-gray-500'
                          : item.danger
                            ? 'text-red-600 dark:text-red-400 bg-red-50/80 dark:bg-red-900/20 hover:bg-red-100/80 dark:hover:bg-red-900/30'
                            : 'text-gray-800 dark:text-gray-100 hover:bg-gray-100/80 dark:hover:bg-slate-700/50'
                      }
                    `}
                    disabled={item.disabled}
                  >
                    <div className="flex items-center space-x-3">
                      <Icon className="w-5 h-5 icon-muted" />
                      <span className="font-medium">{item.label}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        {modalElement}
        {shareExpiryElement}
      </>
    );
  }

  // Desktop: floating menu — position from measure-then-clamp so it always stays on screen
  const desktopMenu = (
    <div
      ref={menuRef}
      className="fixed z-50 material-thick material-edge rounded-2xl py-2 min-w-48 focus:outline-none"
      style={{
        left: `${menuStyle.x}px`,
        top: `${menuStyle.y}px`,
        visibility: menuVisible ? 'visible' : 'hidden',
        opacity: menuVisible ? 1 : 0,
        animation: menuVisible ? 'menuIn 0.15s cubic-bezier(0.16, 1, 0.3, 1)' : 'none',
      }}
      tabIndex={-1}
      role="menu"
      aria-label="File actions menu"
    >
      <div className="px-4 py-2.5 border-b border-gray-200/30 dark:border-slate-700/30">
        <p className="text-xs font-medium text-gray-500/80 dark:text-gray-400/80">
          {selectedCount} item{selectedCount !== 1 ? 's' : ''} selected
        </p>
      </div>

      {menuItems.map((item, index) => {
        const Icon = item.icon;
        const isFocused = focusedIndex === index;
        return (
          <button
            key={index}
            onClick={() => {
              if (!item.disabled) {
                item.action();
                onClose();
              }
            }}
            className={`
              w-full flex items-center space-x-3 px-4 py-2.5 text-left
              transition-all duration-150
              rounded-lg
              focus:outline-none
              ${
                item.disabled
                  ? 'opacity-50 cursor-not-allowed text-gray-400 dark:text-gray-500'
                  : isFocused
                    ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                    : item.danger
                      ? 'text-red-600 dark:text-red-400 hover:bg-red-50/50 dark:hover:bg-red-900/20'
                      : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100/80 dark:hover:bg-slate-700/50'
              }
            `}
            disabled={item.disabled}
            tabIndex={0}
            role="menuitem"
            aria-selected={isFocused}
            onMouseEnter={() => setFocusedIndex(index)}
          >
            <Icon className="w-4 h-4 icon-muted" />
            <span className="text-sm font-medium">{item.label}</span>
          </button>
        );
      })}
    </div>
  );

  return (
    <>
      {typeof document !== 'undefined' && document.body ? createPortal(desktopMenu, document.body) : desktopMenu}
      {modalElement}
      {shareExpiryElement}
      <FileInfoModal isOpen={infoOpen} onClose={() => setInfoOpen(false)} file={infoFile} currentPath={currentPath} />
    </>
  );
};
