// UI-level stores: toasts, context menus, modal dialogs, long-running operations.
import type { ReactNode } from "react";
import { create } from "zustand";
import { errorMessage, isGitError } from "./api";

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

interface Dialog {
  id: number;
  render: (close: (v: unknown) => void) => ReactNode;
  resolve: (v: unknown) => void;
}

export type Overlay =
  | { kind: "blame"; root: string; path: string; rev: string | null; line?: number }
  | { kind: "compare"; root: string; from: string; to: string }
  | { kind: "rebase"; root: string; base: string | null; oldest: string }
  | { kind: "stash"; root: string; index: number }
  | { kind: "tree"; root: string; rev: string };

interface UiState {
  toasts: Toast[];
  menu: { x: number; y: number; items: MenuItem[] } | null;
  dialogs: Dialog[];
  busy: BusyOp[];
  paletteOpen: boolean;
  overlay: Overlay | null;
  repositoryOverview: boolean;
  focusMode: boolean;
  toast: (t: Omit<Toast, "id">, ttl?: number) => void;
  dismissToast: (id: number) => void;
  openMenu: (x: number, y: number, items: MenuItem[]) => void;
  closeMenu: () => void;
  setPalette: (open: boolean) => void;
}

let toastId = 0;
let dialogId = 0;

export const useUi = create<UiState>()((set, get) => ({
  toasts: [],
  menu: null,
  dialogs: [],
  busy: [],
  paletteOpen: false,
  overlay: null,
  repositoryOverview: false,
  focusMode: false,
  toast: (t, ttl) => {
    const id = ++toastId;
    set({ toasts: [...get().toasts.slice(-4), { ...t, id }] });
    const life = ttl ?? (t.kind === "error" ? 9000 : 4200);
    if (life > 0) setTimeout(() => get().dismissToast(id), life);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  openMenu: (x, y, items) => set({ menu: { x, y, items } }),
  closeMenu: () => set({ menu: null }),
  setPalette: (open) => set({ paletteOpen: open }),
}));

export const toast = {
  info: (title: string, detail?: string) => useUi.getState().toast({ kind: "info", title, detail }),
  success: (title: string, detail?: string) => useUi.getState().toast({ kind: "success", title, detail }),
  warning: (title: string, detail?: string) => useUi.getState().toast({ kind: "warning", title, detail }),
  error: (e: unknown, title?: string) => {
    const msg = errorMessage(e);
    const detail = isGitError(e) && e.details.length ? `${msg}\n${e.details.slice(0, 8).join("\n")}` : msg;
    useUi.getState().toast({ kind: "error", title: title ?? "Operation failed", detail });
  },
};

/** Opens a modal and resolves with whatever the dialog passes to `close`. */
export function showDialog<T>(render: (close: (v: T) => void) => ReactNode): Promise<T> {
  return new Promise<T>((resolve) => {
    const id = ++dialogId;
    const dialog: Dialog = {
      id,
      render: render as (close: (v: unknown) => void) => ReactNode,
      resolve: (v) => {
        useUi.setState({ dialogs: useUi.getState().dialogs.filter((d) => d.id !== id) });
        resolve(v as T);
      },
    };
    useUi.setState({ dialogs: [...useUi.getState().dialogs, dialog] });
  });
}

export function contextMenu(e: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation?: () => void }, items: MenuItem[]) {
  e.preventDefault();
  e.stopPropagation?.();
  useUi.getState().openMenu(e.clientX, e.clientY, items);
}

export function startBusy(id: string, label: string) {
  useUi.setState({ busy: [...useUi.getState().busy, { id, label, line: "", started: Date.now() }] });
}

const lastBusyUpdate = new Map<string, number>();

/** Git prints progress many times a second; apply at most a few updates per second. */
export function updateBusy(id: string, line: string) {
  const now = Date.now();
  if (now - (lastBusyUpdate.get(id) ?? 0) < 250 && !/100%|done/.test(line)) return;
  lastBusyUpdate.set(id, now);
  const busy = useUi.getState().busy;
  if (!busy.some((b) => b.id === id)) return;
  useUi.setState({ busy: busy.map((b) => (b.id === id ? { ...b, line } : b)) });
}

export function endBusy(id: string) {
  useUi.setState({ busy: useUi.getState().busy.filter((b) => b.id !== id) });
}

export async function copyText(text: string, what = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(what, text.length > 80 ? text.slice(0, 80) + "…" : text);
  } catch (e) {
    toast.error(e, "Copy failed");
  }
}

export function openOverlay(o: Overlay) {
  useUi.setState({ overlay: o });
}

export function closeOverlay() {
  useUi.setState({ overlay: null });
}
