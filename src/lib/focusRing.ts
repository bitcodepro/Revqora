/**
 * Focus rings only while the user moves through the app with Tab.
 *
 * The browser shows `:focus-visible` on its own terms: when the window is activated again, when
 * a closed dialog gives focus back to the button that opened it, or after any key press. A ring
 * then appears around a toolbar button nobody is navigating to. The ring is drawn only while
 * `data-keyboard-nav` is set (see base.css): Tab sets it, a pointer press clears it.
 */
export function installKeyboardFocus(doc: Document = document): () => void {
  const root = doc.documentElement;
  const capture = { capture: true };
  const keyboard = (event: KeyboardEvent) => {
    if (event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey) root.setAttribute("data-keyboard-nav", "");
  };
  const pointer = () => root.removeAttribute("data-keyboard-nav");
  doc.addEventListener("keydown", keyboard, capture);
  doc.addEventListener("pointerdown", pointer, capture);
  return () => {
    doc.removeEventListener("keydown", keyboard, capture);
    doc.removeEventListener("pointerdown", pointer, capture);
    root.removeAttribute("data-keyboard-nav");
  };
}
