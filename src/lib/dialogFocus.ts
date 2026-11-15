/** Initial focus must not steal focus already placed by a person or automation. */
export function scheduleDialogFocus(current: () => HTMLElement | null, mode: "auto" | "dialog" = "auto"): () => void {
  const timer = setTimeout(() => {
    const dialog = current();
    if (!dialog || dialog.contains(dialog.ownerDocument.activeElement)) return;
    if (mode === "dialog") {
      // Nothing is pre-selected, so Enter or Space typed elsewhere cannot answer the dialog.
      dialog.focus({ preventScroll: true });
      return;
    }
    const target = dialog.querySelector<HTMLElement>("input:not([disabled]):not([type=checkbox]):not([type=radio]), textarea:not([disabled]), select:not([disabled]), button.primary:not([disabled])")
      ?? dialog.querySelector<HTMLElement>("button:not([disabled])");
    target?.focus();
    if (target?.tagName === "INPUT") (target as HTMLInputElement).select();
  }, 30);
  return () => clearTimeout(timer);
}

const FOCUSABLE = "a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1']), [contenteditable=true]";

/** Menus, pickers, toasts and other dialogs live outside a dialog and keep their own focus. */
export const FOCUS_COMPANIONS = ".ctx-menu, .palette, .modal, .toasts, [data-dialog-companion]";

/** The controls Tab can reach inside `root`, in document order. */
export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(el => !el.closest("[inert]") && el.getClientRects().length > 0);
}

/** Where Tab or Shift+Tab must go to stay inside a dialog, or null when the browser's own
 *  step already stays inside. A dialog without controls keeps focus on itself. */
export function trappedTabTarget<T>(items: readonly T[], active: unknown, dialog: T, backwards: boolean): T | null {
  if (!items.length) return dialog;
  const first = items[0], last = items[items.length - 1];
  if (backwards) return active === first || active === dialog ? last : null;
  return active === last ? first : null;
}

/** The opener to focus again when a dialog closes: only if it still exists and focus was left
 *  inside the closing dialog or nowhere (an action that focused another control keeps it). */
export function focusReturnTarget(opener: HTMLElement | null, active: Element | null, body: Element, dialog: { contains(node: Element): boolean }): HTMLElement | null {
  if (!opener || opener === body || !opener.isConnected || opener.closest("[inert]")) return null;
  const lost = !active || active === body || !active.isConnected || dialog.contains(active);
  return lost ? opener : null;
}
