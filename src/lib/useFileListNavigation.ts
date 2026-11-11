import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { actionFor, matchesShortcut } from "./shortcuts";

const editable = "input,textarea,select,[role='textbox'],[contenteditable]:not([contenteditable='false']),.cm-editor";
const listShortcuts = [
  ["fileListNext", "ArrowDown"], ["fileListPrevious", "ArrowUp"],
  ["fileListFirst", "Home"], ["fileListLast", "End"],
];

/** Traverse the rendered rows, so collapsed folders and duplicate staged/working paths stay distinct. */
export function useFileListNavigation(navigateChanges = false) {
  const ref = useRef<HTMLDivElement>(null);
  const [doc, setDocument] = useState<Document | null>(null);
  const attach = useCallback((node: HTMLDivElement | null) => {
    ref.current = node;
    setDocument(node?.ownerDocument ?? null);
  }, []);
  const move = useCallback((key: string, focusList = true) => {
    const rows = [...(ref.current?.querySelectorAll<HTMLElement>("[data-file-nav]") ?? [])].filter(row => row.getClientRects().length);
    if (!rows.length) return false;
    const current = rows.findIndex(row => row.classList.contains("selected"));
    const next = key === "Home" ? 0 : key === "End" ? rows.length - 1 : current < 0 ? (key === "ArrowUp" ? rows.length - 1 : 0) : Math.max(0, Math.min(rows.length - 1, current + (key === "ArrowDown" ? 1 : -1)));
    rows[next].click();
    if (focusList) ref.current?.focus({ preventScroll: true });
    rows[next].scrollIntoView({ block: "nearest", inline: "nearest" });
    return true;
  }, []);
  const onKeyDown = useCallback((e: KeyboardEvent<HTMLDivElement>) => {
    if (actionFor(e)) return;
    if (e.currentTarget.ownerDocument.querySelector(".modal-backdrop,.ctx-menu,.conflict-overlay")) return;
    const target = e.target as HTMLElement;
    if (target.closest(editable) || target.closest("button,a") && !target.closest("button[data-file-nav]")) return;
    const command = listShortcuts.find(([id]) => matchesShortcut(e, id));
    if (command && move(command[1])) { e.preventDefault(); e.stopPropagation(); }
  }, [move]);
  const onClickCapture = useCallback((e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (e.detail > 0 && target.closest("[data-file-nav]") && !target.closest(editable) && (!target.closest("button,a") || target.closest("button[data-file-nav]"))) ref.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const view = doc?.defaultView;
    if (!doc || !view) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (actionFor(e)) return;
      if (doc.activeElement?.closest(editable) || doc.querySelector(".modal-backdrop,.ctx-menu,.conflict-overlay")) return;
      const next = matchesShortcut(e, "previewNextFile") || matchesShortcut(e, "previewNextFileAlternate");
      const previous = matchesShortcut(e, "previewPreviousFile") || matchesShortcut(e, "previewPreviousFileAlternate");
      const command = next ? "ArrowDown" : previous ? "ArrowUp" : navigateChanges ? listShortcuts.find(([id]) => matchesShortcut(e, id))?.[1] : undefined;
      if (command && move(command, false)) e.preventDefault();
    };
    view.addEventListener("keydown", onKey);
    return () => view.removeEventListener("keydown", onKey);
  }, [doc, move, navigateChanges]);
  return { ref: attach, onKeyDown, onClickCapture, tabIndex: 0, "aria-description": "Use Up/Down to preview files; Home/End jump to the first/last visible file." };
}
