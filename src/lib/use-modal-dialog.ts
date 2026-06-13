import { useEffect, type RefObject } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Focus management for a modal dialog/sheet: moves focus in when it opens,
// restores it to the previously-focused element on close, and traps Tab within
// the panel. Pair with role="dialog" aria-modal="true" on the element the ref
// points at. `enabled` lets a stacked sheet hand the trap to whichever sheet is
// on top (e.g. the queue sheet over the now-playing sheet).
export function useModalDialogFocus(
  open: boolean,
  panelRef: RefObject<HTMLElement | null>,
  options?: { enabled?: boolean },
): void {
  const enabled = options?.enabled ?? true;

  useEffect(() => {
    if (!open || !enabled) return;
    const panel = panelRef.current;
    if (!panel || typeof document === "undefined") return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const raf = requestAnimationFrame(() => {
      const focusable = panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      (focusable[0] ?? panel).focus();
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || !panel.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !panel.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [open, enabled, panelRef]);
}
