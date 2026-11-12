import { useCallback, useEffect, useRef, useState } from "react";
import { treeSelection } from "./libraryTree";
import { matchesShortcut } from "./shortcuts";
import { useUi } from "./ui";

export function useNavigationSelection<T extends HTMLElement>() {
  const panel = useRef<T>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const anchor = useRef<string | null>(null);
  const plainSelection = useRef<string | null>(null);
  const clear = useCallback(() => {
    setSelection([]);
    anchor.current = null;
    plainSelection.current = null;
  }, []);

  useEffect(() => {
    if (!selection.length) return;
    const view = panel.current?.ownerDocument.defaultView;
    const onKey = (event: KeyboardEvent) => {
      const { dialogs, menu, paletteOpen } = useUi.getState();
      if (event.defaultPrevented || menu || paletteOpen || dialogs.some(dialog => dialog.surface === view)) return;
      if (!matchesShortcut(event, "navigationClearSelection")) return;
      const target = event.target;
      if (event.key !== "Escape" && (!target || !("nodeType" in target) || !panel.current?.contains(target as Node))) return;
      clear();
    };
    view?.addEventListener("keydown", onKey);
    return () => view?.removeEventListener("keydown", onKey);
  }, [selection.length, clear]);

  function select(ids: string[], id: string, active: string | null, range: boolean, toggle: boolean) {
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

  return { panel, selection, clear, select, keyDown };
}
