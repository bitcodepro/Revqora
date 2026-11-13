import { useCallback, useEffect, useRef, useState } from "react";
import { treeSelection } from "./libraryTree";
import { matchesShortcut } from "./shortcuts";
import { useUi } from "./ui";

export function useNavigationSelection<T extends HTMLElement>() {
  const panel = useRef<T>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const anchor = useRef<string | null>(null);
  const plainSelection = useRef<string | null>(null);
  const allSelection = useRef<string[] | null>(null);
  const clear = useCallback(() => {
    setSelection(current => current.length ? [] : current);
    anchor.current = null;
    plainSelection.current = null;
    allSelection.current = null;
  }, []);

  useEffect(() => {
    const view = panel.current?.ownerDocument.defaultView;
    if (!view) return;
    const blocked = () => {
      const { dialogs, menu, paletteOpen } = useUi.getState();
      return menu || paletteOpen || dialogs.some(dialog => dialog.surface === view) || view.document.body.classList.contains("explorer-dragging");
    };
    const insidePanel = (target: EventTarget | null) => !!target && "nodeType" in target && panel.current?.contains(target as Node);
    const onKey = (event: KeyboardEvent) => {
      if (blocked() || !matchesShortcut(event, "navigationClearSelection")) return;
      if (event.key === "Escape" || insidePanel(event.target)) clear();
    };
    const onClick = (event: MouseEvent) => {
      if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && !insidePanel(event.target) && !blocked()) clear();
    };
    view.addEventListener("keydown", onKey, true);
    view.addEventListener("click", onClick, true);
    return () => {
      view.removeEventListener("keydown", onKey, true);
      view.removeEventListener("click", onClick, true);
    };
  }, [clear]);

  function select(ids: string[], id: string, active: string | null, range: boolean, toggle: boolean) {
    allSelection.current = null;
    const previous = anchor.current && ids.includes(anchor.current) ? anchor.current : active;
    if (range || toggle) {
      const plain = plainSelection.current;
      plainSelection.current = null;
      setSelection(current => {
        const selected = current.filter(item => ids.includes(item));
        if (plain && ids.includes(plain) && !selected.includes(plain)) selected.push(plain);
        return treeSelection(ids, selected, previous, id, range, toggle);
      });
      if (!range || !previous || !ids.includes(previous)) anchor.current = id;
      return true;
    }
    setSelection([]);
    anchor.current = id;
    plainSelection.current = id;
    return false;
  }

  function selectAll(ids: string[], id: string, extend: boolean) {
    const next = extend ? [...new Set([...selection, ...ids])] : ids;
    allSelection.current = next;
    anchor.current = id;
    plainSelection.current = null;
    setSelection(next);
  }

  function keyDown(event: React.KeyboardEvent, ids: string[], id: string, active: string | null) {
    if (event.repeat) return;
    const extend = matchesShortcut(event, "navigationAddSelectionRange");
    const range = extend || matchesShortcut(event, "navigationSelectRange");
    const toggle = extend || matchesShortcut(event, "navigationToggleSelection");
    if (!range && !toggle) return;
    event.preventDefault();
    event.stopPropagation();
    select(ids, id, active, range, toggle);
  }

  const selectedAllAt = (id: string) => allSelection.current === selection && anchor.current === id;
  return { panel, selection, clear, select, keyDown, selectAll, selectedAllAt };
}
