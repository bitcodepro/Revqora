import { useLayoutEffect, type RefObject } from "react";
import { FOCUS_COMPANIONS, focusables, focusReturnTarget, trappedTabTarget } from "./dialogFocus";

/** Keeps Tab and focus inside a dialog that is not built on Modal while `active`, and returns
 *  focus to the control that opened it when it closes. */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean) {
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!active || !dialog) return;
    const doc = dialog.ownerDocument;
    // Recorded before the dialog focuses its own field.
    const opener = doc.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || e.ctrlKey || e.altKey || e.metaKey) return;
      const target = trappedTabTarget(focusables(dialog), doc.activeElement, dialog, e.shiftKey);
      if (!target) return;
      e.preventDefault();
      target.focus({ preventScroll: true });
    };
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target || dialog.contains(target) || target.closest?.(FOCUS_COMPANIONS)) return;
      (focusables(dialog)[0] ?? dialog).focus({ preventScroll: true });
    };
    dialog.addEventListener("keydown", onKey);
    doc.addEventListener("focusin", onFocusIn);
    return () => {
      dialog.removeEventListener("keydown", onKey);
      doc.removeEventListener("focusin", onFocusIn);
      focusReturnTarget(opener, doc.activeElement, doc.body, dialog)?.focus({ preventScroll: true });
    };
  }, [ref, active]);
}
