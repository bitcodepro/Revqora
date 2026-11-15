// Drag and drop of branches and commits in History and the Branches panel.
//
// The drag is driven by pointer events, like Explorer moves (lib/libraryDrag.ts) and the branch
// comparison: the main window keeps Tauri's native file drop (`dragDropEnabled`), and with it the
// webview does not deliver HTML5 `dragover`/`drop` events on Windows. Everything is resolved in
// the document the drag started in, so a detached panel window drags within itself.
//
// A drop never starts an operation. It opens a menu of the actions lib/graphDrop.ts offers, and
// the chosen item runs the same action functions as the context menus.
import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowDown, CloudUpload, FastForward, GitCommitHorizontal, GitCompareArrows, GitMerge, GitPullRequestArrow, RotateCcw } from "lucide-react";
import * as A from "../lib/actions";
import { shortOid } from "../lib/format";
import { dragItemLabel, graphDropActions, type DragItem, type DropAction, type DropActionId, type DropBranchRef, type DropRepoState, type DropTarget } from "../lib/graphDrop";
import { getTab, type RepoTab } from "../lib/store";
import { contextMenu, openOverlay, toast, type MenuItem } from "../lib/ui";

const I = 14;
/** Pointer travel, in pixels, before a press becomes a drag. A click never starts one. */
const DRAG_THRESHOLD = 6;
const DROP_MARK = "data-graph-drop";

const ICONS: Record<DropActionId, React.ReactNode> = {
  merge: <GitMerge size={I} />,
  rebase: <GitPullRequestArrow size={I} />,
  "fast-forward": <FastForward size={I} />,
  pull: <ArrowDown size={I} />,
  push: <CloudUpload size={I} />,
  "cherry-pick": <GitCommitHorizontal size={I} />,
  reset: <RotateCcw size={I} />,
  compare: <GitCompareArrows size={I} />,
};

/** The repository facts the drop rules need, or null while they are not loaded. */
export function dropRepoState(tab: RepoTab | undefined): DropRepoState | null {
  if (!tab?.info || !tab.refs) return null;
  return {
    head: tab.info.head.detached ? null : tab.info.head.branch,
    operation: tab.info.state.kind,
    local: tab.refs.local,
    remote: tab.refs.remote,
    otherWorktreeBranches: (tab.extras?.worktrees ?? []).flatMap(w => !w.isCurrent && !w.bare && !w.detached && w.branch ? [w.branch] : []),
  };
}

/** Runs the chosen drop action through the existing actions, switching branch first when the label said so. */
export async function runDropAction(root: string, action: DropAction) {
  const run = action.run;
  if (run.type === "compare") {
    openOverlay({ kind: "compare", root, from: run.from, to: run.to });
    return;
  }
  const head = getTab(root)?.info?.head;
  const current = head && !head.detached ? head.branch : null;
  if (current !== action.branch && !action.switches) {
    toast.warning("Current branch changed", "Review the current branch and try again.");
    return;
  }
  // Pull confirms and performs its own checkout of the tracking branch.
  if (run.type === "pull" && !run.fastForwardOnly) {
    await A.pullBranch(root, { branch: run.branch, upstream: run.upstream });
    return;
  }
  if (action.branch && current !== action.branch && (await A.checkout(root, action.branch, "local")) !== action.branch) return;
  switch (run.type) {
    case "merge": return A.mergeInto(root, run.source);
    case "rebase": return A.rebaseOnto(root, run.onto);
    case "cherry-pick": return A.cherryPick(root, run.oids);
    case "reset": return A.resetTo(root, run.oid, run.subject);
    case "push": return A.push(root);
    case "pull": return A.pull(root, "ff-only", undefined, undefined, { branch: run.branch, upstream: run.upstream });
  }
}

export function dropMenuItems(root: string, actions: DropAction[]): MenuItem[] {
  const items: MenuItem[] = [];
  for (const action of actions) {
    if (action.id === "compare" && items.length) items.push({ separator: true });
    items.push({
      label: action.label,
      icon: ICONS[action.id],
      hint: action.disabled ?? action.hint,
      disabled: !!action.disabled,
      onClick: () => void runDropAction(root, action),
    });
  }
  return items;
}

/** The commits a History row drags: the multi-selection it belongs to, or itself. */
export interface CommitDrag {
  /** Oldest first, the order they are applied in. */
  oids: string[];
  /** Runs when the press becomes a drag (History restores the selection the press changed). */
  onStart?: () => void;
}

function badgeRef(badge: HTMLElement): DropBranchRef | null {
  const { refKind, refName } = badge.dataset;
  if (!refName) return null;
  if (refKind === "head" || refKind === "local") return { scope: "local", name: refName };
  return refKind === "remote" ? { scope: "remote", name: refName } : null;
}

function branchRowRef(row: HTMLElement): DropBranchRef | null {
  const { branchKind, branchName } = row.dataset;
  return branchName && (branchKind === "local" || branchKind === "remote") ? { scope: branchKind, name: branchName } : null;
}

const commitSubject = (row: HTMLElement) => row.querySelector(".g-subject .text")?.textContent ?? "";

/** The branch badge, Branches row or commit row at `element`: the same lookup for sources and targets. */
function dropElement(element: Element | null): { element: HTMLElement; ref: DropBranchRef } | { element: HTMLElement; oid: string } | null {
  const badge = element?.closest<HTMLElement>("[data-ref-kind]");
  const badgeBranch = badge && badgeRef(badge);
  if (badge && badgeBranch) return { element: badge, ref: badgeBranch };
  const branchRow = element?.closest<HTMLElement>("[data-branch-ref]");
  const rowBranch = branchRow && branchRowRef(branchRow);
  if (branchRow && rowBranch) return { element: branchRow, ref: rowBranch };
  const row = element?.closest<HTMLElement>("[data-commit-oid]");
  return row?.dataset.commitOid ? { element: row, oid: row.dataset.commitOid } : null;
}

function targetAt(doc: Document, x: number, y: number, root: string): { element: HTMLElement; target: DropTarget } | null {
  const hit = doc.elementFromPoint(x, y);
  // Only the History list and Branches panel of the same repository take drops.
  if (hit?.closest<HTMLElement>("[data-drop-root]")?.dataset.dropRoot !== root) return null;
  const found = dropElement(hit);
  if (!found) return null;
  return "ref" in found
    ? { element: found.element, target: { kind: "branch", ...found.ref } }
    : { element: found.element, target: { kind: "commit", oid: found.oid, subject: commitSubject(found.element) } };
}

/**
 * Returns the `onPointerDown` handler for a History list or Branches panel of `root` (the
 * container also carries `data-drop-root`). One delegated handler serves every row and badge,
 * so rows get no extra props. `commitsAt` resolves the commits a History row drags; without it
 * commit rows are not drag sources.
 */
export function useGraphDrag(root: string, commitsAt?: (oid: string) => CommitDrag | null) {
  const cancel = useRef<(() => void) | null>(null);
  const resolveCommits = useRef(commitsAt);
  resolveCommits.current = commitsAt;
  useEffect(() => () => cancel.current?.(), []);

  return useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || !e.isPrimary || e.pointerType === "touch" || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const origin = e.target as Element;
    // Controls keep their own behavior; the lane column keeps hover and pinning.
    if (origin.closest("button, input, select, textarea, a, .g-graph")) return;
    const doc = e.currentTarget.ownerDocument, view = doc.defaultView;
    const source = dropElement(origin);
    if (!view || !source) return;

    let item: DragItem;
    let label: string;
    let onStart: (() => void) | undefined;
    if ("ref" in source) {
      item = { kind: "branch", ...source.ref };
      label = dragItemLabel(item);
      // Pressing a badge also presses its History row, which toggles that row's selection.
      const rowOid = source.element.closest<HTMLElement>("[data-commit-oid]")?.dataset.commitOid;
      onStart = rowOid ? resolveCommits.current?.(rowOid)?.onStart : undefined;
    } else {
      // Read the selection now: the mousedown that follows this pointerdown changes it.
      const commits = resolveCommits.current?.(source.oid);
      if (!commits?.oids.length) return;
      item = { kind: "commits", oids: commits.oids };
      label = dragItemLabel(item, commitSubject(source.element));
      onStart = commits.onStart;
    }

    cancel.current?.();
    const { pointerId, clientX, clientY } = e;
    let dragging = false;
    let state: DropRepoState | null = null;
    let hovered: Element | null = null;
    let marked: HTMLElement | null = null;
    let frame = 0;
    let x = clientX, y = clientY;
    const marker = doc.createElement("div");
    marker.className = "graph-drag-label";
    marker.setAttribute("aria-hidden", "true");
    marker.textContent = label;

    const mark = (force = false) => {
      const found = targetAt(doc, x, y, root);
      if (!force && (found?.element ?? null) === hovered) return;
      hovered = found?.element ?? null;
      const valid = !!found && !!state && graphDropActions(item, found.target, state).length > 0;
      marked?.removeAttribute(DROP_MARK);
      marked = valid ? found.element : null;
      marked?.setAttribute(DROP_MARK, "");
      marker.toggleAttribute("data-valid", valid);
      marker.textContent = valid
        ? `${label} → ${found.target.kind === "branch" ? found.target.name : shortOid(found.target.oid)}`
        : label;
    };
    // Keep scrolling while the pointer rests near the top or bottom edge of a list.
    const scroll = () => {
      const list = doc.elementFromPoint(x, y)?.closest<HTMLElement>(".graph-scroll, .sb-scroll");
      if (list) {
        const bounds = list.getBoundingClientRect();
        const edge = Math.min(32, bounds.height / 4);
        const previous = list.scrollTop;
        if (y < bounds.top + edge) list.scrollTop -= Math.ceil((bounds.top + edge - y) / 4);
        if (y > bounds.bottom - edge) list.scrollTop += Math.ceil((y - bounds.bottom + edge) / 4);
        if (list.scrollTop !== previous) mark(true);
      }
      frame = view.requestAnimationFrame(scroll);
    };
    const move = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      if (!dragging && Math.hypot(event.clientX - clientX, event.clientY - clientY) < DRAG_THRESHOLD) return;
      if (!dragging) {
        dragging = true;
        state = dropRepoState(getTab(root));
        onStart?.();
        doc.body.append(marker);
        doc.body.classList.add("graph-dragging");
        frame = view.requestAnimationFrame(scroll);
      }
      event.preventDefault();
      x = event.clientX;
      y = event.clientY;
      marker.style.transform = `translate(${x + 12}px, ${y + 14}px)`;
      mark();
    };
    // The release that ends a drag must not also click the row or badge under the pointer.
    const swallowClick = () => {
      const swallow = (click: MouseEvent) => { click.stopPropagation(); click.preventDefault(); };
      view.addEventListener("click", swallow, true);
      view.setTimeout(() => view.removeEventListener("click", swallow, true), 0);
    };
    const cleanup = () => {
      marker.remove();
      marked?.removeAttribute(DROP_MARK);
      marked = null;
      doc.body.classList.remove("graph-dragging");
      view.cancelAnimationFrame(frame);
      view.removeEventListener("pointermove", move);
      view.removeEventListener("pointerup", up);
      view.removeEventListener("pointercancel", cleanup);
      view.removeEventListener("blur", cleanup);
      view.removeEventListener("keydown", key, true);
      cancel.current = null;
    };
    const up = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      const wasDragging = dragging;
      const found = wasDragging ? targetAt(doc, event.clientX, event.clientY, root) : null;
      cleanup();
      if (!wasDragging) return;
      swallowClick();
      // Decide on the state at the drop, not on the one the drag started with.
      const current = dropRepoState(getTab(root));
      if (!found || !current) return;
      const actions = graphDropActions(item, found.target, current);
      if (!actions.length) return;
      contextMenu({ clientX: event.clientX, clientY: event.clientY, currentTarget: found.element, preventDefault: () => {} }, dropMenuItems(root, actions));
    };
    const key = (event: KeyboardEvent) => {
      if (!dragging || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      cleanup();
      // The button is still down: its release is the end of the cancelled drag, not a click.
      view.addEventListener("pointerup", swallowClick, { once: true });
    };
    cancel.current = cleanup;
    view.addEventListener("pointermove", move);
    view.addEventListener("pointerup", up);
    view.addEventListener("pointercancel", cleanup);
    view.addEventListener("blur", cleanup);
    view.addEventListener("keydown", key, true);
  }, [root]);
}
