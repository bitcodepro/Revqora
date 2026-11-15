// UI-level stores: toasts, context menus, modal dialogs, long-running operations.
import type { ReactNode } from "react";
import { create } from "zustand";
import { errorMessage, isGitError } from "./api";
import { focusedUiSurface } from "./uiSurfaces";
import { recordError } from "./errorLog";

export type ToastKind = "info" | "success" | "error" | "warning";

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
  action?: { label: string; run: () => void };
}

export interface MenuItem {
  label?: string;
  icon?: ReactNode;
  hint?: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  separator?: boolean;
  checked?: boolean;
  onClick?: () => void;
  children?: MenuItem[];
}

export interface BusyOp {
  id: string;
  label: string;
  line: string;
  started: number;
}

export interface RepositoryOperation {
  id: string;
  repo: string;
  repositoryKey: string;
  command: string;
  phase: "queued" | "running" | "finished" | "failed";
  ahead: number;
}

export function updateRepositoryOperation(op: RepositoryOperation) {
  const others = useUi.getState().repositoryOperations.filter((o) => o.id !== op.id);
  useUi.setState({ repositoryOperations: op.phase === "finished" || op.phase === "failed" ? others : [...others, op] });
}

interface Dialog {
  id: number;
  surface: Window;
  render: (close: (v: unknown) => void) => ReactNode;
  resolve: (v: unknown) => void;
}

export type Overlay =
  | {kind:"historyExplorer";root:string}
  | {kind:"stacks";root:string}
  | { kind: "workflows"; root: string; pull?: import("./prWorkflow").PrWorkflowSeed }
  | { kind: "agents"; root: string }
  | { kind: "branches"; root: string }
  | { kind: "worktrees"; root: string }
  | { kind: "blame"; root: string; path: string; rev: string | null; line?: number }
  | { kind: "compare"; root: string; from: string; to: string; direct?: boolean }
  | { kind: "rebase"; root: string; base: string | null; oldest: string }
  | { kind: "stash"; root: string; index: number; oid: string }
  | { kind: "tree"; root: string; rev: string };

interface UiState {
  toasts: Toast[];
  /** `opener` is the element focused when the menu opened: focus returns there when it closes. */
  menu: { x: number; y: number; items: MenuItem[]; surface: Window; opener: HTMLElement | null } | null;
  dialogs: Dialog[];
  busy: BusyOp[];
  repositoryOperations: RepositoryOperation[];
  paletteOpen: boolean;
  explorerReveal: string | null;
  branchReveal: { root: string; reference: string } | null;
  overlay: Overlay | null;
  overlayRevision: number;
  repositoryOverview: boolean;
  toast: (t: Omit<Toast, "id">, ttl?: number) => void;
  dismissToast: (id: number) => void;
  /** Pauses a toast's timer while it is hovered or focused (it is read or acted on). */
  holdToast: (id: number, held: boolean) => void;
  openMenu: (x: number, y: number, items: MenuItem[], surface?: Window) => void;
  closeMenu: () => void;
  setPalette: (open: boolean) => void;
}

const toastTimers = new Map<number, { life: number; timer?: ReturnType<typeof setTimeout> }>();
function startToastTimer(id: number, life: number) {
  clearTimeout(toastTimers.get(id)?.timer);
  toastTimers.set(id, { life, timer: setTimeout(() => useUi.getState().dismissToast(id), life) });
}
let toastId = 0;
let dialogId = 0;

export const useUi = create<UiState>()((set, get) => ({
  toasts: [],
  menu: null,
  dialogs: [],
  busy: [],
  repositoryOperations: [],
  paletteOpen: false,
  explorerReveal: null,
  branchReveal: null,
  overlay: null,
  overlayRevision: 0,
  repositoryOverview: false,
  toast: (t, ttl) => {
    const id = ++toastId;
    set({ toasts: [...get().toasts.slice(-4), { ...t, id }] });
    // Errors and toasts with an action stay long enough to read and use; hovering pauses them.
    const life = ttl ?? (t.kind === "error" ? 15000 : t.action ? 12000 : 4200);
    if (life > 0) startToastTimer(id, life);
  },
  dismissToast: (id) => {
    clearTimeout(toastTimers.get(id)?.timer);
    toastTimers.delete(id);
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
  holdToast: (id, held) => {
    const timer = toastTimers.get(id);
    if (!timer) return;
    if (held) { clearTimeout(timer.timer); timer.timer = undefined; }
    else if (!timer.timer) startToastTimer(id, Math.max(2500, timer.life / 2));
  },
  openMenu: (x, y, items, surface = focusedUiSurface()) => set({ menu: { x, y, items, surface, opener: get().menu?.opener ?? (surface.document.activeElement as HTMLElement | null) } }),
  closeMenu: () => set({ menu: null }),
  setPalette: (open) => set({ paletteOpen: open }),
}));

export const toast = {
  info: (title: string, detail?: string) => useUi.getState().toast({ kind: "info", title, detail }),
  success: (title: string, detail?: string) => useUi.getState().toast({ kind: "success", title, detail }),
  warning: (title: string, detail?: string) => useUi.getState().toast({ kind: "warning", title, detail }),
  error: (e: unknown, title?: string) => {
    recordError(title ?? "Interface", e);
    const msg = errorMessage(e);
    const detail = isGitError(e) && e.details.length ? `${msg}\n${e.details.slice(0, 8).join("\n")}` : msg;
    useUi.getState().toast({ kind: "error", title: title ?? "Operation failed", detail });
  },
};

/** Opens a modal and resolves with whatever the dialog passes to `close`. */
export function showDialog<T>(render: (close: (v: T) => void) => ReactNode, timeout?: { ms: number; value: T }): Promise<T> {
  return new Promise<T>((resolve) => {
    const id = ++dialogId;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const dialog: Dialog = {
      id,
      surface: focusedUiSurface(),
      render: render as (close: (v: unknown) => void) => ReactNode,
      resolve: (v) => {
        if (closed) return;
        closed = true;
        clearTimeout(timer);
        useUi.setState({ dialogs: useUi.getState().dialogs.filter((d) => d.id !== id) });
        resolve(v as T);
      },
    };
    if (timeout) timer = setTimeout(() => dialog.resolve(timeout.value), timeout.ms);
    useUi.setState({ dialogs: [...useUi.getState().dialogs, dialog] });
  });
}

export function contextMenu(e: { clientX: number; clientY: number; currentTarget?: EventTarget | null; preventDefault: () => void; stopPropagation?: () => void }, items: MenuItem[]) {
  e.preventDefault();
  e.stopPropagation?.();
  useUi.getState().openMenu(e.clientX, e.clientY, items, (e.currentTarget as HTMLElement | null)?.ownerDocument?.defaultView ?? undefined);
}

export function toggleRepositoryOverview() {
  useUi.setState(state => ({ repositoryOverview: !state.repositoryOverview }));
}

export function startBusy(id: string, label: string) {
  useUi.setState({ busy: [...useUi.getState().busy, { id, label, line: "", started: Date.now() }] });
}

const lastBusyUpdate = new Map<string, number>();

/** Git prints progress many times a second; apply at most a few updates per second. */
export function updateBusy(id: string, line: string, immediate = false) {
  const now = Date.now();
  if (!immediate && now - (lastBusyUpdate.get(id) ?? 0) < 250 && !/100%|done/.test(line)) return;
  const busy = useUi.getState().busy;
  if (!busy.some((b) => b.id === id)) return;
  lastBusyUpdate.set(id, now);
  useUi.setState({ busy: busy.map((b) => (b.id === id ? { ...b, line } : b)) });
}

export function endBusy(id: string) {
  lastBusyUpdate.delete(id);
  useUi.setState({ busy: useUi.getState().busy.filter((b) => b.id !== id) });
}

export async function copyText(text: string, what = "Copied") {
  try {
    await focusedUiSurface().navigator.clipboard.writeText(text);
    toast.success(what, text.length > 80 ? text.slice(0, 80) + "…" : text);
  } catch (e) {
    toast.error(e, "Copy failed");
  }
}

export function openOverlay(o: Overlay) {
  useUi.setState(s => ({ overlay: o, overlayRevision: s.overlayRevision + 1, repositoryOverview: false }));
  if (typeof window !== "undefined" && focusedUiSurface() !== window) window.focus();
}

export function closeOverlay() {
  useUi.setState(s => ({ overlay: null, overlayRevision: s.overlayRevision + 1 }));
}

export interface OverlayOwner { overlay: Overlay; revision: number }

/** Capture the originating navigation, including close/reopen of the same object. */
export function captureOverlay(kind: Overlay["kind"], root: string): OverlayOwner | undefined {
  const { overlay, overlayRevision } = useUi.getState();
  return overlay?.kind === kind && overlay.root === root ? { overlay, revision: overlayRevision } : undefined;
}

export function closeOwnedOverlay(owner: OverlayOwner) {
  useUi.setState(s => s.overlay === owner.overlay && s.overlayRevision === owner.revision
    ? { overlay: null, overlayRevision: s.overlayRevision + 1 } : s);
}
