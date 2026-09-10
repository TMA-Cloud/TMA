import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useIsMobile } from '../../hooks/useIsMobile';
import { SPRING_PRESETS, projectedEndpoint, rubberband, useDrag, useReducedMotion, useSpring } from '../../motion';

// Track how many modals are currently open to avoid restoring scroll prematurely
let openModalCount = 0;

/** How long the exit path takes; the enter path mirrors it. */
const EXIT_MS = 240;

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

/**
 * A modal task, so the surface is paired with a scrim: dimming everything else
 * says plainly that the rest of the interface is on hold. A panel that ran
 * alongside the user's flow would use translucency and offset instead, and no
 * scrim at all.
 *
 * On a touch layout it arrives as a sheet from the bottom edge and can be
 * thrown back out the same way. On a pointer layout it materialises in place.
 * Either way the exit retraces the path the entrance took — a surface that
 * slides up from the bottom and then fades out sideways breaks any sense that
 * it went back where it came from.
 */
export const Modal: React.FC<ModalProps> = ({ isOpen, onClose, title, children, size = 'md', initialFocusRef }) => {
  const modalRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const sheetHeight = useRef(0);
  const isMobile = useIsMobile();
  const reducedMotion = useReducedMotion();

  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Kept mounted through the exit so the surface can leave along the path it
  // arrived on rather than blinking out.
  const [rendered, setRendered] = useState(isOpen);
  const [leaving, setLeaving] = useState(false);
  const [openedLast, setOpenedLast] = useState(isOpen);

  // Reacting during render rather than in an effect: the surface has to know
  // it is leaving on the same frame the prop flips, or the exit starts a beat
  // late and reads as a stutter.
  if (openedLast !== isOpen) {
    setOpenedLast(isOpen);
    if (isOpen) {
      setRendered(true);
      setLeaving(false);
    } else if (rendered) {
      setLeaving(true);
    }
  }

  // Drives the drag-to-dismiss offset. A spring rather than a transition,
  // because the sheet has to be catchable mid-flight: grab a closing sheet and
  // it should follow the finger from wherever it currently is, not finish
  // closing and then reopen.
  const offset = useSpring(0, SPRING_PRESETS.sheet);

  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setRendered(false), reducedMotion ? 0 : EXIT_MS);
    return () => clearTimeout(timer);
  }, [leaving, reducedMotion]);

  useEffect(() => {
    return offset.subscribe(value => {
      const element = modalRef.current;
      if (!element) return;
      element.style.transform = value === 0 ? '' : `translate3d(0, ${value}px, 0)`;
      // Fading the scrim with the drag both keeps the two layers related and
      // warns that letting go here will dismiss.
      const height = sheetHeight.current || 1;
      const scrim = scrimRef.current;
      if (scrim && value > 0) scrim.style.opacity = String(Math.max(0, 1 - (value / height) * 1.2));
    });
  }, [offset]);

  useEffect(() => {
    if (!isOpen) return;

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
    // Focus requested element or fallback to the first focusable node.
    // Never scrolling to it: focusing a control near the foot of a long modal
    // would otherwise open it already scrolled past its own first line.
    setTimeout(() => {
      if (initialFocusRef?.current) {
        initialFocusRef.current.focus({ preventScroll: true });
      } else {
        const first = modalRef.current?.querySelector<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        first?.focus({ preventScroll: true });
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
  }, [isOpen, initialFocusRef]);

  const isSheet = isMobile && size !== 'full';

  const onDragStart = useCallback(() => {
    sheetHeight.current = modalRef.current?.getBoundingClientRect().height ?? 1;
    offset.hold();
  }, [offset]);

  const onDragMove = useCallback(
    (state: { dy: number }) => {
      // Downward the sheet tracks the finger exactly. Upward there is nothing
      // to reveal, so it resists progressively rather than stopping dead — a
      // hard stop reads as frozen, resistance reads as "nothing more here".
      const height = sheetHeight.current || 1;
      offset.track(state.dy >= 0 ? state.dy : -rubberband(-state.dy, height), 0);
    },
    [offset]
  );

  const onDragEnd = useCallback(
    (state: { dy: number; vy: number }) => {
      const height = sheetHeight.current || 1;
      // Decide from where the throw was heading, not from where the finger
      // stopped: a hard flick and a slow nudge that ended in the same place
      // are not the same intent.
      const landing = projectedEndpoint(Math.max(state.dy, 0), state.vy);

      if (landing > height * 0.4) {
        // Carry on at the finger's exact speed, so there is no visible seam
        // between dragging and animating.
        offset.setTarget(height * 1.15, state.vy);
        onCloseRef.current();
        return;
      }

      offset.setTarget(0, state.vy);
    },
    [offset]
  );

  const dragHandlers = useDrag<HTMLDivElement>({
    axis: 'y',
    threshold: 8,
    disabled: !isSheet,
    onStart: onDragStart,
    onMove: onDragMove,
    onEnd: onDragEnd,
    onCancel: () => offset.setTarget(0),
  });

  if (!rendered) return null;

  const sizeClasses = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
    full: 'max-w-full h-full max-h-full',
  };

  const enterAnimation = reducedMotion
    ? 'animate-fadeIn'
    : isSheet
      ? 'animate-slideUp'
      : size === 'full'
        ? 'animate-fadeIn'
        : 'animate-modalIn';

  return (
    <div
      className="fixed inset-x-0 top-0 z-50 h-screen overflow-hidden"
      style={{ height: '100dvh' }}
      aria-modal="true"
      role="dialog"
    >
      <div
        className={`flex h-full min-h-0 ${isSheet ? 'items-end' : 'items-center'} justify-center ${
          size === 'full' || isSheet ? 'p-0' : 'p-4'
        }`}
      >
        {/* Dim to focus. The scrim is what makes this read as a task rather
            than a parallel panel, so it is the layer that says "stop", and the
            exit fades it on the mirrored curve. */}
        <div
          ref={scrimRef}
          className={`fixed inset-0 bg-[var(--scrim)] transition-opacity duration-300 ${
            leaving
              ? 'opacity-0 ease-[cubic-bezier(0.64,0,0.78,0)]'
              : 'animate-fadeIn ease-[cubic-bezier(0.22,1,0.36,1)]'
          }`}
          onClick={onClose}
        />

        <div
          ref={modalRef}
          onMouseDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
          style={{
            transformOrigin: isSheet ? 'bottom center' : 'center',
            willChange: 'transform, opacity',
            // The vh class is the legacy fallback. Dynamic viewport units are
            // applied inline so they win when Safari supports them.
            maxHeight: size === 'full' ? undefined : isSheet ? '92dvh' : '90dvh',
          }}
          className={`
            relative z-10 flex min-h-0 flex-col material-thick material-edge text-[var(--label)]
            ${sizeClasses[size]} w-full
            ${
              size === 'full'
                ? 'h-full max-h-full rounded-none'
                : isSheet
                  ? 'rounded-t-3xl max-h-[92vh]'
                  : 'rounded-3xl max-h-[90vh]'
            }
            overflow-hidden
            ${leaving ? 'material-leaving scale-[0.96]' : enterAnimation}
          `}
        >
          {/* The grabber is the affordance: it names the top edge as the part
              you can take hold of, and it is where the drag is armed. */}
          {isSheet && (
            <div
              {...dragHandlers}
              className="pt-2.5 pb-1 flex justify-center cursor-grab active:cursor-grabbing touch-none"
            >
              <div className="h-1 w-9 rounded-full bg-[var(--fill-primary)]" />
            </div>
          )}

          <div
            {...(isSheet ? dragHandlers : {})}
            className={`flex items-center justify-between gap-3 border-b border-[var(--separator)] ${
              size === 'full' ? 'px-4 py-3' : isSheet ? 'px-5 pb-3 pt-1 touch-none' : 'px-6 py-5'
            }`}
          >
            <h3 className={`${size === 'full' ? 'type-headline' : 'type-title-3'} vibrant min-w-0 truncate`}>
              {title}
            </h3>
            <button
              onClick={onClose}
              className="pressable flex-shrink-0 grid place-items-center w-8 h-8 rounded-full bg-[var(--fill-quaternary)] text-[var(--label-secondary)] hover:bg-[var(--fill-tertiary)] hover:text-[var(--label)]"
              aria-label="Close modal"
            >
              <X className="w-4 h-4" strokeWidth={2.5} />
            </button>
          </div>

          <div
            className={`scroller min-h-0 flex-1 overflow-y-auto ${
              size === 'full'
                ? 'p-4 pb-[max(1rem,env(safe-area-inset-bottom))]'
                : isSheet
                  ? 'px-5 pt-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]'
                  : 'p-6'
            }`}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
};
