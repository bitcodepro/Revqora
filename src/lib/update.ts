import { create } from "zustand";
import { listen } from "@tauri-apps/api/event";
import { api, errorMessage } from "./api";
import { useSettings } from "./settings";
import type { UpdateInfo } from "./types";

export type UpdatePhase = "idle" | "checking" | "downloading" | "installing" | "ready" | "error";

interface UpdateState {
  info: UpdateInfo | null;
  phase: UpdatePhase;
  /** 0..1 while downloading. */
  progress: number;
  error: string | null;
  checkedAt: number | null;
  check: (manual?: boolean) => Promise<UpdateInfo | null>;
  install: () => Promise<void>;
  restart: () => Promise<void>;
}

const RECHECK_MS = 6 * 60 * 60 * 1000;

export const useUpdate = create<UpdateState>()((set, get) => ({
  info: null,
  phase: "idle",
  progress: 0,
  error: null,
  checkedAt: null,
  check: async (manual = false) => {
    const busy = get().phase;
    if (busy === "checking" || busy === "downloading" || busy === "installing" || busy === "ready") return get().info;
    set({ phase: "checking", error: null });
    try {
      const info = await api.updateCheck();
      set({ info, phase: "idle", checkedAt: Date.now() });
      return info;
    } catch (e) {
      // Background checks stay quiet when offline; a manual check shows why it failed.
      set({ phase: manual ? "error" : "idle", error: manual ? errorMessage(e) : null, checkedAt: Date.now() });
      return null;
    }
  },
  install: async () => {
    set({ phase: "downloading", progress: 0, error: null });
    const un = await listen<{ downloaded: number; total: number }>("update-progress", (e) => {
      const { downloaded, total } = e.payload;
      const progress = total > 0 ? Math.min(1, downloaded / total) : 0;
      set({ progress, phase: progress >= 1 ? "installing" : "downloading" });
    });
    try {
      await api.updateInstall();
      set({ phase: "ready", progress: 1 });
    } catch (e) {
      set({ phase: "error", error: errorMessage(e) });
    } finally {
      un();
    }
  },
  restart: async () => {
    try {
      await api.updateRestart();
    } catch (e) {
      set({ phase: "error", error: errorMessage(e) });
    }
  },
}));

/** An update worth showing: newer than this build and not skipped by the user. */
export function visibleUpdate(info: UpdateInfo | null, skipped: string | null): UpdateInfo | null {
  if (!info?.available) return null;
  return info.latest === skipped ? null : info;
}

let started = false;

/** Checks shortly after start (when enabled) and then every few hours. */
export function startUpdateChecks() {
  if (started) return;
  started = true;
  const run = () => {
    if (useSettings.getState().checkUpdates) useUpdate.getState().check();
  };
  setTimeout(run, 4000);
  setInterval(run, RECHECK_MS);
}
