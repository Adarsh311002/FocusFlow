import { motion } from 'motion/react';
import { type KeyboardEvent, type ReactNode, type RefObject, useEffect, useRef } from 'react';

// The full-screen shell of the rituals (the daily intention, IN3, and the weekly review,
// WR4): the forest dims around one moment. A modal dialog: focus moves in and stays in
// (Tab wraps), the page behind does not scroll, Esc asks to leave, and focus returns to
// where it was when the shell closes.

const EASE = [0.22, 1, 0.36, 1] as const;

function focusableIn(root: HTMLElement): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>(
      'input:not([disabled]), button:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ];
}

export function RitualShell({
  titleId,
  describedById,
  initialFocus,
  onEscape,
  children,
}: {
  readonly titleId: string;
  readonly describedById?: string;
  /** Receives the focus when the shell opens. */
  readonly initialFocus: RefObject<HTMLElement | null>;
  /** Esc; `null` while leaving is not possible (a save in flight, a confirmation shown). */
  readonly onEscape: (() => void) | null;
  readonly children: ReactNode;
}) {
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    initialFocus.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
      previous?.focus();
    };
    // Only on open and close: the target is read once, when the shell appears.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape' && onEscape !== null) {
      event.preventDefault();
      onEscape();
      return;
    }
    if (event.key !== 'Tab' || dialog.current === null) {
      return;
    }
    const items = focusableIn(dialog.current);
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) {
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <motion.div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={describedById}
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-[80] flex items-center justify-center overflow-y-auto px-6 py-16"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.8 } }}
      transition={{ duration: 0.9, ease: EASE }}
    >
      <div aria-hidden="true" className="absolute inset-0 bg-canvas/85 backdrop-blur-xl" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-1/2 h-[70vh] w-[70vw] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,var(--ff-moon),transparent_65%)] blur-2xl"
      />
      {children}
    </motion.div>
  );
}
