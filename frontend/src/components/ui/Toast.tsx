import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X, CheckCircle2, AlertCircle, Info } from 'lucide-react';
import { SPRING_PRESETS, projectedEndpoint, rubberband, useDrag, useSpring } from '../../motion';

/** Matches the exit path, so the node finishes leaving before it is unmounted. */
const EXIT_MS = 300;

interface ToastProps {
  id: string;
  message: string;
  type?: 'success' | 'error' | 'info';
  duration?: number;
  onClose: (id: string) => void;
}

/**
 * Feedback that reports completion, and nothing more.
 *
 * It is swipeable in either direction: a notification that lands while you are
 * reading should go away in whichever direction your hand was already moving,
 * not only the one direction a designer picked.
 */
export const Toast: React.FC<ToastProps> = ({ id, message, type = 'info', duration = 5000, onClose }) => {
  const [leaving, setLeaving] = useState(false);
  const nodeRef = useRef<HTMLDivElement>(null);
  const width = useRef(0);
  const dismissedRef = useRef(false);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // The horizontal offset lives on a spring so a half-finished swipe can be
  // caught and pulled back, instead of the toast insisting on finishing first.
  const offset = useSpring(0, SPRING_PRESETS.momentum);

  useEffect(() => {
    return offset.subscribe(value => {
      const element = nodeRef.current;
      if (!element) return;
      element.style.transform = `translate3d(${value}px, 0, 0)`;
      // Fading with distance tells the user how near they are to letting go.
      const span = width.current || 1;
      element.style.opacity = String(Math.max(0, 1 - Math.abs(value) / span));
    });
  }, [offset]);

  const dismiss = useCallback(() => {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    setLeaving(true);
    setTimeout(() => onCloseRef.current(id), EXIT_MS);
  }, [id]);

  useEffect(() => {
    const timer = setTimeout(dismiss, duration);
    return () => clearTimeout(timer);
  }, [dismiss, duration]);

  const dragHandlers = useDrag<HTMLDivElement>({
    axis: 'x',
    threshold: 8,
    onStart: () => {
      width.current = nodeRef.current?.getBoundingClientRect().width ?? 1;
      offset.hold();
    },
    onMove: state => {
      const span = width.current || 1;
      const limit = span * 1.4;
      // There is room to throw in both directions, so resistance only appears
      // once the gesture has run well past anything meaningful.
      const value =
        Math.abs(state.dx) < limit
          ? state.dx
          : Math.sign(state.dx) * (limit + rubberband(Math.abs(state.dx) - limit, span));
      offset.track(value, 0);
    },
    onEnd: state => {
      const span = width.current || 1;
      const landing = projectedEndpoint(state.dx, state.vx);

      if (Math.abs(landing) > span * 0.5) {
        // Out the side it was thrown towards, at the speed it was thrown —
        // gesture and animation are one continuous motion.
        offset.setTarget(Math.sign(landing) * span * 1.6, state.vx);
        dismiss();
        return;
      }

      offset.setTarget(0, state.vx);
    },
    onCancel: () => offset.setTarget(0),
  });

  const icons = {
    success: CheckCircle2,
    error: AlertCircle,
    info: Info,
  };

  const tints = {
    success: 'text-[var(--positive-text)]',
    error: 'text-[var(--destructive-text)]',
    info: 'text-[var(--accent)]',
  };

  const Icon = icons[type];

  return (
    <div
      ref={nodeRef}
      {...dragHandlers}
      className={`
        material-regular material-edge rounded-2xl
        px-4 py-3 flex items-center gap-3 min-w-80 max-w-[26rem]
        cursor-grab active:cursor-grabbing touch-pan-y select-none
        ${
          leaving
            ? 'opacity-0 translate-y-4 scale-[0.96] transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.64,0,0.78,0)]'
            : 'animate-toastIn'
        }
      `}
      style={{ willChange: 'transform, opacity' }}
      aria-live="polite"
      role="status"
    >
      {/* Colour sits on the icon rather than a filled bar: the message is the
          content and the severity is a qualifier on it, not the other way up. */}
      <Icon className={`w-5 h-5 flex-shrink-0 ${tints[type]}`} strokeWidth={2.25} />
      <p className="type-callout vibrant flex-1 min-w-0">{message}</p>
      <button
        onClick={dismiss}
        className="pressable flex-shrink-0 grid place-items-center w-6 h-6 rounded-full text-[var(--label-tertiary)] hover:bg-[var(--fill-quaternary)] hover:text-[var(--label)]"
        aria-label="Close notification"
      >
        <X className="w-3.5 h-3.5" strokeWidth={2.5} />
      </button>
    </div>
  );
};

interface ToastContainerProps {
  toasts: Array<{
    id: string;
    message: string;
    type?: 'success' | 'error' | 'info';
  }>;
  onClose: (id: string) => void;
}

export const ToastContainer: React.FC<ToastContainerProps> = ({ toasts, onClose }) => {
  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 items-end pointer-events-none">
      {toasts.map(toast => (
        <div key={toast.id} className="pointer-events-auto">
          <Toast {...toast} onClose={onClose} />
        </div>
      ))}
    </div>
  );
};
