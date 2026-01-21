import React, { useState } from "react";
import { ToastContext, type Toast } from "./useToast";
import { ToastContainer } from "../components/ui/Toast";

const MAX_VISIBLE_TOASTS = 3;

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const showToast = (
    message: string,
    type: "success" | "error" | "info" = "info",
  ) => {
    const id = Date.now().toString();
    const newToast = { id, message, type };

    setToasts((prev) => {
      const updatedToasts = [...prev, newToast];
      return updatedToasts.slice(-MAX_VISIBLE_TOASTS);
    });
  };

  const removeToast = (id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  };

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <ToastContainer toasts={toasts} onClose={removeToast} />
    </ToastContext.Provider>
  );
};
