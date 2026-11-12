import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { treeSubtreeIds, type TreeEntry, type TreePlacement } from "./libraryTree";

interface DropTarget<T> {
  element: HTMLElement;
  value: T;
  position?: "before" | "after";
  hint?: string;
}

export function useLibraryPointerDrag() {
  const cancel = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);
  useEffect(() => () => cancel.current?.(), []);
  return {
    suppressClick,
    start<T>(
      e: ReactPointerEvent<HTMLElement>,
      label: string,
      findTarget: (hit: Element | null, y: number) => DropTarget<T> | null,
      drop: (target: T) => void,
    ) {
      if (e.button !== 0 || !e.isPrimary || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      const doc = e.currentTarget.ownerDocument, view = doc.defaultView;
      if (!view) return;
      cancel.current?.();
      const { pointerId, clientX, clientY } = e;
      let dragging = false;
      let target: DropTarget<T> | null = null;
      let frame = 0;
      let x = clientX, y = clientY;
      const marker = doc.createElement("div");
      marker.className = "repository-drag-label";
      marker.textContent = label;
      const targetClass = (item: DropTarget<T>) => item.position ? `library-drop-${item.position}` : "workspace-drop-active";
      const clearTarget = () => { if (target) target.element.classList.remove(targetClass(target)); };
      const markTarget = () => {
        const next = findTarget(doc.elementFromPoint(x, y), y);
        marker.textContent = next?.hint ?? label;
        if (target?.element === next?.element && target?.position === next?.position) return;
        clearTarget();
        target = next;
        if (target) target.element.classList.add(targetClass(target));
      };
      const scroll = () => {
        const list = doc.elementFromPoint(x, y)?.closest<HTMLElement>(".explorer-tree");
        if (list) {
          const bounds = list.getBoundingClientRect();
          const edge = Math.min(32, bounds.height / 4);
          const previous = list.scrollTop;
          if (y < bounds.top + edge) list.scrollTop -= Math.ceil((bounds.top + edge - y) / 4);
          if (y > bounds.bottom - edge) list.scrollTop += Math.ceil((y - bounds.bottom + edge) / 4);
          if (list.scrollTop !== previous) markTarget();
        }
        frame = view.requestAnimationFrame(scroll);
      };
      const move = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) return;
        if (!dragging && Math.hypot(event.clientX - clientX, event.clientY - clientY) < 6) return;
        if (!dragging) {
          dragging = true;
          doc.body.append(marker);
          doc.body.classList.add("explorer-dragging");
          frame = view.requestAnimationFrame(scroll);
        }
        event.preventDefault();
        x = event.clientX;
        y = event.clientY;
        marker.style.transform = `translate(${x + 12}px, ${y + 12}px)`;
        markTarget();
      };
      const cleanup = () => {
        marker.remove();
        doc.body.classList.remove("explorer-dragging");
        view.cancelAnimationFrame(frame);
        clearTarget();
        view.removeEventListener("pointermove", move);
        view.removeEventListener("pointerup", up);
        view.removeEventListener("pointercancel", cleanup);
        view.removeEventListener("blur", cleanup);
        view.removeEventListener("keydown", key, true);
        cancel.current = null;
      };
      const up = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) return;
        const destination = dragging ? findTarget(doc.elementFromPoint(event.clientX, event.clientY), event.clientY) : null;
        cleanup();
        if (!dragging) return;
        suppressClick.current = true;
        setTimeout(() => { suppressClick.current = false; }, 0);
        if (destination) drop(destination.value);
      };
      const key = (event: KeyboardEvent) => {
        if (!dragging || event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        cleanup();
      };
      cancel.current = cleanup;
      view.addEventListener("pointermove", move);
      view.addEventListener("pointerup", up);
      view.addEventListener("pointercancel", cleanup);
      view.addEventListener("blur", cleanup);
      view.addEventListener("keydown", key, true);
    },
  };
}

const dropRows = "[data-tree-group], [data-explorer-repository]";

export function findExplorerDropElement(hit: Element | null, y: number) {
  const row = hit?.closest<HTMLElement>(`${dropRows}, [data-explorer-root-drop]`);
  if (row) return row;
  const tree = hit?.closest(".explorer-tree");
  if (!tree) return null;
  // The gap between rows belongs to their insertion edges, too.
  const adjacent = Array.from(tree.querySelectorAll<HTMLElement>(dropRows)).find(element => {
    const { top, bottom } = element.getBoundingClientRect();
    return y >= top - 3 && y <= bottom + 3;
  });
  return adjacent ?? tree.querySelector<HTMLElement>("[data-explorer-root-drop]");
}

export function dropEdge(element: HTMLElement, y: number, edge = 0.28) {
  const { top, height } = element.getBoundingClientRect();
  const fraction = (y - top) / height;
  return fraction < edge ? "before" : fraction >= 1 - edge ? "after" : undefined;
}

export interface TreeDestination { parentId: string | null; placement?: TreePlacement }

export function findTreeDrop(
  entries: readonly TreeEntry[],
  ids: readonly string[],
) {
  const moving = treeSubtreeIds(entries, ids);
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const lastRoot = [...entries].reverse().find(entry => !entry.parentId && !moving.has(entry.id));
  return (hit: Element | null, y: number): DropTarget<TreeDestination> | null => {
    const element = findExplorerDropElement(hit, y);
    if (!element) return null;
    const id = element.dataset.treeGroup;
    if (!id) {
      if (element.dataset.explorerRepository && element.dataset.repositoryParent) return null;
      return { element, hint: "Move to top level", value: { parentId: null, placement: lastRoot && { siblingId: lastRoot.id, after: true } } };
    }
    const entry = byId.get(id);
    if (!entry || moving.has(id)) return null;
    const position = dropEdge(element, y);
    return position
      ? { element, position, hint: `Insert ${position} ${entry.name}`, value: { parentId: entry.parentId ?? null, placement: { siblingId: id, after: position === "after" } } }
      : { element, hint: `Move into ${entry.name}`, value: { parentId: id } };
  };
}
