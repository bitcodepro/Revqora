import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ThemePref = "system" | "dark" | "light";
export type DiffMode = "unified" | "split";
export type DateStyle = "relative" | "absolute";

export interface Settings {
  theme: ThemePref;
  uiFontSize: number;
  codeFontSize: number;
  uiFont: string;
  codeFont: string;
  diffMode: DiffMode;
  ignoreWhitespace: boolean;
  contextLines: number;
  dateStyle: DateStyle;
  confirmDiscard: boolean;
  showRemoteBranchesInGraph: boolean;
  wrapDiff: boolean;
  recent: string[];
  openTabs: string[];
  activeTab: string | null;
  sidebarWidth: number;
  detailsHeight: number;
  changesListWidth: number;
  pullMode: "ff-only" | "merge" | "rebase";
  commitGraphDismissed: string[];
  avatars: boolean;
  fileView: "list" | "tree";
  graphWidth: number;
  graphColumns: { author: boolean; date: boolean; hash: boolean };
  largeFileMb: number;
  conventionalCommits: boolean;
  shortcuts: Record<string, string>;
  onboarded: boolean;
  syncScroll: boolean;
  diffFullFile: boolean;
  checkUpdates: boolean;
  /** Background fetch interval in minutes; 0 turns it off. */
  autoFetchMinutes: number;
  /** History layout: the graph, or Review (commit list, files and a full-height diff). */
  historyMode: "graph" | "review";
  reviewListWidth: number;
  skippedUpdate: string | null;
  set: (patch: Partial<Settings>) => void;
  addRecent: (path: string) => void;
  removeRecent: (path: string) => void;
}

export const UI_FONTS = ["Inter Variable", "Segoe UI Variable Text", "Segoe UI", "system-ui"];
export const CODE_FONTS = ["JetBrains Mono Variable", "Cascadia Code", "Cascadia Mono", "Consolas", "monospace"];

export const useSettings = create<Settings>()(
  persist(
    (set, get) => ({
      theme: "system",
      uiFontSize: 13,
      codeFontSize: 12.5,
      uiFont: "Inter Variable",
      codeFont: "JetBrains Mono Variable",
      diffMode: "unified",
      ignoreWhitespace: false,
      contextLines: 3,
      dateStyle: "relative",
      confirmDiscard: true,
      showRemoteBranchesInGraph: true,
      wrapDiff: false,
      recent: [],
      openTabs: [],
      activeTab: null,
      sidebarWidth: 264,
      detailsHeight: 340,
      changesListWidth: 360,
      pullMode: "ff-only",
      commitGraphDismissed: [],
      avatars: false,
      fileView: "list",
      graphWidth: 0,
      graphColumns: { author: true, date: true, hash: true },
      largeFileMb: 50,
      conventionalCommits: false,
      shortcuts: {},
      onboarded: false,
      syncScroll: true,
      diffFullFile: false,
      checkUpdates: true,
      autoFetchMinutes: 5,
      historyMode: "graph",
      reviewListWidth: 340,
      skippedUpdate: null,
      set: (patch) => set(patch),
      addRecent: (path) => set({ recent: [path, ...get().recent.filter((p) => p.toLowerCase() !== path.toLowerCase())].slice(0, 15) }),
      removeRecent: (path) => set({ recent: get().recent.filter((p) => p !== path) }),
    }),
    { name: "revqora.settings", version: 1 },
  ),
);

export function resolvedTheme(pref: ThemePref): "dark" | "light" {
  if (pref === "system") return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  return pref;
}
