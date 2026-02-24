import React, { useRef, useState } from 'react';
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

  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    const now = Date.now();
    const last = lastToastRef.current;

    // Drop identical toasts that fire in a tight loop
    if (last && last.message === message && last.type === type && now - last.timestamp < TOAST_DEDUP_WINDOW_MS) {
      return;
    }

    const id = Date.now().toString();
    const newToast = { id, message, type };

    lastToastRef.current = { message, type, timestamp: now };

    setToasts(prev => {
      const updatedToasts = [...prev, newToast];
      return updatedToasts.slice(-MAX_VISIBLE_TOASTS);
    });
  };

  const removeToast = (id: string) => {
    setToasts(prev => prev.filter(toast => toast.id !== id));
  };

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <ToastContainer toasts={toasts} onClose={removeToast} />
    </ToastContext.Provider>
  );
};
