import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { repositoryKey, type ExplorerPlacement, type RepositoryGroup } from "./repositoryLibrary";

interface DropTarget<T> {
  element: HTMLElement;
  value: T;
  position?: "before" | "after";
  subtreeHeight?: number;
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
      const clearTarget = () => {
        if (!target) return;
        target.element.classList.remove(targetClass(target));
        target.element.style.removeProperty("--drop-subtree-height");
      };
      const markTarget = () => {
        const next = findTarget(doc.elementFromPoint(x, y), y);
        marker.textContent = next?.hint ?? label;
        if (target?.element === next?.element && target?.position === next?.position && target?.subtreeHeight === next?.subtreeHeight) return;
        clearTarget();
        target = next;
        if (target) {
          target.element.classList.add(targetClass(target));
          if (target.subtreeHeight) target.element.style.setProperty("--drop-subtree-height", `${target.subtreeHeight}px`);
        }
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

function findExplorerDropElement(hit: Element | null, y: number) {
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

function dropEdge(element: HTMLElement, y: number, edge = 0.28) {
  const { top, height } = element.getBoundingClientRect();
  const fraction = (y - top) / height;
  return fraction < edge ? "before" : fraction >= 1 - edge ? "after" : undefined;
}

// Show an after-folder insertion line below its visible children.
function subtreeHeight(element: HTMLElement) {
  if (element.getAttribute("aria-expanded") !== "true") return 0;
  const depth = Number(element.getAttribute("aria-level"));
  let last = element;
  let next = element.nextElementSibling;
  while (next?.hasAttribute("aria-level") && Number(next.getAttribute("aria-level")) > depth) {
    last = next as HTMLElement;
    next = next.nextElementSibling;
  }
  return last.offsetTop + last.offsetHeight - element.offsetTop - element.offsetHeight;
}

interface ExplorerDestination { parentId: string | null; placement?: ExplorerPlacement }

export function findExplorerDrop(
  groups: readonly RepositoryGroup[],
  movingGroups: ReadonlySet<string>,
  movingRepositories: ReadonlySet<string>,
) {
  const byId = new Map(groups.map(group => [group.id, group]));
  return (hit: Element | null, y: number): DropTarget<ExplorerDestination> | null => {
    const element = findExplorerDropElement(hit, y);
    if (!element) return null;
    const siblingRoot = element.dataset.explorerRepository;
    const id = element.dataset.treeGroup;
    const name = element.getAttribute("aria-label");
    if (siblingRoot) {
      const parentId = element.dataset.repositoryParent || null;
      if (movingRepositories.has(repositoryKey(siblingRoot)) || (parentId && movingGroups.has(parentId))) return null;
      const position = dropEdge(element, y, 0.5)!;
      return { element, position, hint: `Insert ${position} ${name}`,
        value: { parentId, placement: { siblingRoot, after: position === "after" } } };
    }
    if (!id) return { element, hint: "Move to top level", value: { parentId: null } };
    const group = byId.get(id);
    if (!group || movingGroups.has(id)) return null;
    const position = dropEdge(element, y);
    return position
      ? { element, position, subtreeHeight: position === "after" ? subtreeHeight(element) : undefined, hint: `Insert ${position} ${group.name}`,
        value: { parentId: group.parentId ?? null, placement: { siblingId: id, after: position === "after" } } }
      : { element, hint: `Move into ${group.name}`, value: { parentId: id } };
  };
}
