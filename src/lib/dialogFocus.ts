/** Initial focus must not steal focus already placed by a person or automation. */
export function scheduleDialogFocus(current: () => HTMLElement | null): () => void {
  const timer = setTimeout(() => {
    const dialog = current();
    if (!dialog || dialog.contains(dialog.ownerDocument.activeElement)) return;
    const target = dialog.querySelector<HTMLElement>("input:not([disabled]):not([type=checkbox]):not([type=radio]), textarea:not([disabled]), select:not([disabled]), button.primary:not([disabled])");
    target?.focus();
    if (target?.tagName === "INPUT") (target as HTMLInputElement).select();
  }, 30);
  return () => clearTimeout(timer);
}
