import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { treeSubtreeIds, type TreeEntry, type TreePlacement } from "./libraryTree";

interface DropTarget<T> {
  element: HTMLElement;
  value: T;
  position?: "before" | "after";
}

export function useLibraryPointerDrag() {
  const cancel = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);
  const [moving, setMoving] = useState(false);
  useEffect(() => () => cancel.current?.(), []);
  return {
    moving,
    suppressClick,
    start<T>(
      e: ReactPointerEvent<HTMLElement>,
      label: string,
      findTarget: (hit: Element | null, y: number) => DropTarget<T> | null,
      drop: (target: T) => void,
    ) {
      if (e.button !== 0 || !e.isPrimary) return;
      const doc = e.currentTarget.ownerDocument, view = doc.defaultView;
      if (!view) return;
      cancel.current?.();
      const { pointerId, clientX, clientY } = e;
      let dragging = false;
      let target: DropTarget<T> | null = null;
      const marker = doc.createElement("div");
      marker.className = "repository-drag-label";
      marker.textContent = label;
      const targetClass = (item: DropTarget<T>) => item.position ? `library-drop-${item.position}` : "workspace-drop-active";
      const clearTarget = () => { if (target) target.element.classList.remove(targetClass(target)); };
      const hit = (event: PointerEvent) => findTarget(doc.elementFromPoint(event.clientX, event.clientY), event.clientY);
      const move = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) return;
        if (!dragging && Math.hypot(event.clientX - clientX, event.clientY - clientY) < 6) return;
        if (!dragging) {
          dragging = true;
          setMoving(true);
          doc.body.append(marker);
        }
        event.preventDefault();
        marker.style.transform = `translate(${event.clientX + 12}px, ${event.clientY + 12}px)`;
        const next = hit(event);
        if (target?.element === next?.element && target?.position === next?.position) return;
        clearTarget();
        target = next;
        if (target) target.element.classList.add(targetClass(target));
      };
      const cleanup = () => {
        marker.remove();
        clearTarget();
        if (dragging) setMoving(false);
        view.removeEventListener("pointermove", move);
        view.removeEventListener("pointerup", up);
        view.removeEventListener("pointercancel", cleanup);
        view.removeEventListener("blur", cleanup);
        view.removeEventListener("keydown", key, true);
        cancel.current = null;
      };
      const up = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) return;
        const destination = dragging ? hit(event) : null;
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

export interface TreeDestination { parentId: string | null; placement?: TreePlacement }

export function findTreeDrop(
  attribute: "data-tree-group",
  entries: readonly TreeEntry[],
  ids: readonly string[],
) {
  const moving = treeSubtreeIds(entries, ids);
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  return (hit: Element | null, y: number): DropTarget<TreeDestination> | null => {
    const element = hit?.closest<HTMLElement>(`[${attribute}]`);
    if (!element) return null;
    const id = element.getAttribute(attribute);
    if (!id) return { element, value: { parentId: null } };
    const entry = byId.get(id);
    if (!entry || moving.has(id)) return null;
    const { top, height } = element.getBoundingClientRect();
    const fraction = (y - top) / height;
    const position = fraction < 0.25 ? "before" : fraction > 0.75 ? "after" : undefined;
    return position
      ? { element, position, value: { parentId: entry.parentId ?? null, placement: { siblingId: id, after: position === "after" } } }
      : { element, value: { parentId: id } };
  };
}
