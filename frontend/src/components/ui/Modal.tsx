import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

// Track how many modals are currently open to avoid restoring scroll prematurely
let openModalCount = 0;

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  /**
   * Optional ref of the element to focus when the modal opens.
   * If not provided, the first focusable element will be focused.
   */
  initialFocusRef?: React.RefObject<HTMLElement>;
}

export const Modal: React.FC<ModalProps> = ({ isOpen, onClose, title, children, size = 'md', initialFocusRef }) => {
  const modalRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (isOpen) {
      openModalCount++;
      document.body.style.overflow = 'hidden';
      const handleTab = (e: KeyboardEvent) => {
        if (e.key !== 'Tab') return;
        // Query focusable elements dynamically so the trap stays current
        const focusable = modalRef.current?.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (!focusable || focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last?.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first?.focus();
          }
        }
      };
      const handleEsc = (e: KeyboardEvent) => {
        if (e.key === 'Escape') onCloseRef.current();
      };
      document.addEventListener('keydown', handleTab);
      document.addEventListener('keydown', handleEsc);
      // Focus requested element or fallback to the first focusable node
      setTimeout(() => {
        if (initialFocusRef?.current) {
          initialFocusRef.current.focus();
        } else {
          const first = modalRef.current?.querySelector<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
          );
          first?.focus();
        }
      }, 0);
      return () => {
        openModalCount--;
        if (openModalCount <= 0) {
          openModalCount = 0;
          document.body.style.overflow = 'unset';
        }
        document.removeEventListener('keydown', handleTab);
        document.removeEventListener('keydown', handleEsc);
      };
    }
  }, [isOpen, initialFocusRef]);

  if (!isOpen) return null;

  const sizeClasses = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
    full: 'max-w-full h-full max-h-full rounded-none',
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto" aria-modal="true" role="dialog">
      <div className={`flex min-h-screen items-center justify-center ${size === 'full' ? 'p-0' : 'p-4'}`}>
        {/* Overlay with fade-in/out */}
        <div
          className="fixed inset-0 bg-white/30 dark:bg-white/10 backdrop-blur-lg transition-opacity duration-300 ease-in-out animate-fadeIn"
          onClick={onClose}
        />
        {/* Modal content with enhanced animations */}
        <div
          ref={modalRef}
          onMouseDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
          className={`
          relative z-10 bg-[#dfe3ea] dark:bg-gray-800 shadow-2xl
          ${sizeClasses[size]} w-full ${
            size === 'full' ? 'h-full max-h-full rounded-none' : 'rounded-2xl max-h-[90vh]'
          } overflow-hidden
          transform transition-all duration-300 ease-out
          animate-modalIn border border-gray-200/50 dark:border-gray-700/50
        `}
        >
          <div
            className={`flex items-center justify-between border-b border-gray-200 dark:border-gray-700 bg-gradient-to-r from-[#dfe3ea] to-[#d4d9e1] dark:from-gray-800 dark:to-gray-900 ${
              size === 'full' ? 'p-4' : 'p-6'
            }`}
          >
            <h3
              className={`${
                size === 'full' ? 'text-base' : 'text-lg'
              } font-semibold text-gray-900 dark:text-gray-100 animate-slideDown`}
            >
              {title}
            </h3>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-all duration-300 hover:scale-110 hover:rotate-90 active:scale-95 rounded-lg p-1.5 hover:bg-gray-200 dark:hover:bg-gray-700 touch-manipulation"
              aria-label="Close modal"
            >
              <X className={`${size === 'full' ? 'w-5 h-5' : 'w-5 h-5'}`} />
            </button>
          </div>
          <div
            className={`${size === 'full' ? 'p-4' : 'p-6'} overflow-y-auto ${
              size === 'full' ? 'max-h-[calc(100vh-5rem)]' : 'max-h-[calc(90vh-8rem)]'
            }`}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
};
