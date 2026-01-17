import React, { useEffect, useState, useRef } from "react";
import { X, CheckCircle, AlertCircle, Info } from "lucide-react";

interface ToastProps {
  id: string;
  message: string;
  type?: "success" | "error" | "info";
  duration?: number;
  onClose: (id: string) => void;
}

export const Toast: React.FC<ToastProps> = ({
  id,
  message,
  type = "info",
  duration = 5000,
  onClose,
}) => {
  const [isVisible, setIsVisible] = useState(true);
  const [touchStartX, setTouchStartX] = useState<number | null>(null);
  const [touchDeltaX, setTouchDeltaX] = useState(0);
  const toastRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setIsVisible(false);
      setTimeout(() => onClose(id), 300);
    }, duration);

    return () => clearTimeout(timer);
  }, [id, duration, onClose]);

  // Swipe-to-dismiss handlers
  const handleTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    setTouchStartX(touch.clientX);
  };
  const handleTouchMove = (e: React.TouchEvent) => {
    if (touchStartX !== null) {
      const touch = e.touches[0];
      if (!touch) return;
      setTouchDeltaX(touch.clientX - touchStartX);
    }
  };
  const handleTouchEnd = () => {
    if (Math.abs(touchDeltaX) > 60) {
      setIsVisible(false);
      setTimeout(() => onClose(id), 300);
    }
    setTouchStartX(null);
    setTouchDeltaX(0);
  };

  const icons = {
    success: CheckCircle,
    error: AlertCircle,
    info: Info,
  };

  const colors = {
    success: "bg-emerald-500",
    error: "bg-red-500",
    info: "bg-blue-500",
  };

  const Icon = icons[type];

  return (
    <div
      ref={toastRef}
      className={`
        transform transition-all duration-300 ease-in-out
        ${isVisible ? "translate-x-0 opacity-100" : "translate-x-full opacity-0"}
        bg-white/80 dark:bg-gray-900/80 backdrop-blur-md rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700
        p-4 flex items-center space-x-3 min-w-80 animate-toastIn mb-2
      `}
      style={{
        marginBottom: "0.5rem",
        touchAction: "pan-y",
        transform: `translateX(${touchDeltaX}px)`,
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      aria-live="polite"
      role="status"
    >
      <div
        className={`${colors[type]} rounded-full p-2 shadow-md animate-bounceIn`}
      >
        <Icon className="w-5 h-5 text-white" />
      </div>
      <p className="text-gray-900 dark:text-gray-100 flex-1 font-medium text-base">
        {message}
      </p>
      <button
        onClick={() => {
          setIsVisible(false);
          setTimeout(() => onClose(id), 300);
        }}
        className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors duration-200 rounded-lg p-1"
        aria-label="Close notification"
      >
        <X className="w-5 h-5" />
      </button>
    </div>
  );
};

interface ToastContainerProps {
  toasts: Array<{
    id: string;
    message: string;
    type?: "success" | "error" | "info";
  }>;
  onClose: (id: string) => void;
}

export const ToastContainer: React.FC<ToastContainerProps> = ({
  toasts,
  onClose,
}) => {
  return (
    <div className="fixed bottom-4 right-4 z-50 space-y-2">
      {toasts.map((toast) => (
        <Toast key={toast.id} {...toast} onClose={onClose} />
      ))}
    </div>
  );
};
