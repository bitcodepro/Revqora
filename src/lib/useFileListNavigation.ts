import { useCallback, useEffect, useRef, type KeyboardEvent, type MouseEvent } from "react";
import { actionFor, comboFromEvent } from "./shortcuts";

const editable = "input,textarea,select,[role='textbox'],[contenteditable]:not([contenteditable='false']),.cm-editor";

/** Traverse the rendered rows, so collapsed folders and duplicate staged/working paths stay distinct. */
export function useFileListNavigation() {
  const ref = useRef<HTMLDivElement>(null);
  const move = useCallback((key: string) => {
    const rows = [...(ref.current?.querySelectorAll<HTMLElement>("[data-file-nav]") ?? [])].filter(row => row.getClientRects().length);
    if (!rows.length) return false;
    const current = rows.findIndex(row => row.classList.contains("selected"));
    const next = key === "Home" ? 0 : key === "End" ? rows.length - 1 : current < 0 ? (key === "ArrowUp" ? rows.length - 1 : 0) : Math.max(0, Math.min(rows.length - 1, current + (key === "ArrowDown" ? 1 : -1)));
    rows[next].click();
    ref.current?.focus({ preventScroll: true });
    rows[next].scrollIntoView({ block: "nearest", inline: "nearest" });
    return true;
  }, []);
  const onKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.nativeEvent.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    if (document.querySelector(".modal-backdrop,.ctx-menu,.conflict-overlay")) return;
    const target = e.target as HTMLElement;
    if (target.closest(editable) || target.closest("button,a") && !target.closest("button[data-file-nav]")) return;
    if (move(e.key)) { e.preventDefault(); e.stopPropagation(); }
  }, [move]);
  const onClickCapture = useCallback((e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-file-nav]") && !target.closest(editable) && (!target.closest("button,a") || target.closest("button[data-file-nav]"))) ref.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !["ArrowDown", "ArrowUp"].includes(e.key)) return;
      const combo=comboFromEvent(e);if(combo&&actionFor(combo))return;
      if (document.activeElement?.closest(editable) || document.querySelector(".modal-backdrop,.ctx-menu,.conflict-overlay")) return;
      if (move(e.key)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move]);
  return { ref, onKeyDown, onClickCapture, tabIndex: 0, "aria-description": "Use Up/Down to preview files; Home/End jump to the first/last visible file. Alt+Up/Down also works from the diff." };
}
