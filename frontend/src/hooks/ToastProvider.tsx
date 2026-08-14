import React, { useCallback, useMemo, useRef, useState } from 'react';
import { ToastContext, type Toast } from './useToast';
import { ToastContainer } from '../components/ui/Toast';

const MAX_VISIBLE_TOASTS = 3;
const TOAST_DEDUP_WINDOW_MS = 1000; // Prevent identical toasts within 1s

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const lastToastRef = useRef<{
    message: string;
    type: 'success' | 'error' | 'info';
    timestamp: number;
  } | null>(null);

  /**
   * Stable for the life of the provider.
   *
   * This provider wraps the whole app, so anything that changes identity here
   * reaches every consumer below it on each toast. That is not just wasted
   * renders: a consumer that keys an effect on `showToast` — useAbortableLoader
   * does — reloads itself every time a toast appears or leaves, and hands the
   * server's answer back to a form the user was still typing into. Only the
   * setter and a ref are used, so there is nothing to depend on.
   */
  const showToast = useCallback((message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const now = Date.now();
    const last = lastToastRef.current;

    // Drop identical toasts that fire in a tight loop
    if (last && last.message === message && last.type === type && now - last.timestamp < TOAST_DEDUP_WINDOW_MS) {
      return;
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const newToast = { id, message, type };

    lastToastRef.current = { message, type, timestamp: now };

    setToasts(prev => {
      const updatedToasts = [...prev, newToast];
      return updatedToasts.slice(-MAX_VISIBLE_TOASTS);
    });
  }, []);

  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(toast => toast.id !== id));
  }, []);

  // A fresh object here would defeat the useCallback above, since the value is
  // what consumers actually subscribe to.
  const value = useMemo(() => ({ showToast }), [showToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastContainer toasts={toasts} onClose={removeToast} />
    </ToastContext.Provider>
  );
};
