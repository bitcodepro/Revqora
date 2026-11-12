import { create } from "zustand";
import { persist } from "zustand/middleware";
import { restoreWorkspaceLayouts, type HistoryMode, type WorkspaceLayout, type WorkspaceMode } from "./workspaceLayouts";

export type ThemePref = "system" | "dark" | "light";
export type DiffMode = "unified" | "split";
export type DateStyle = "relative" | "absolute";
export interface PullRequestWatch {
  selected: Record<number, number>;
}
export type PullRequestWatches = Record<string, Record<string, PullRequestWatch>>;

export interface Settings {
  theme: ThemePref;
  uiFontSize: number;
  codeFontSize: number;
  uiFont: string;
  codeFont: string;
  diffMode: DiffMode;
  ignoreWhitespace: boolean;
  showWhitespace: boolean;
  contextLines: number;
  dateStyle: DateStyle;
  confirmDiscard: boolean;
  showRemoteBranchesInGraph: boolean;
  hideIncomingByRepo: Record<string, true>;
  primaryBranchByRepo: Record<string, string>;
  wrapDiff: boolean;
  recent: string[];
  openTabs: string[];
  openLibraryOnStartup: boolean;
  activeTab: string | null;
  explorerOpen: boolean;
  repositoryActionsCollapsed: boolean;
  explorerFavoritesOnly: boolean;
  layouts: Record<WorkspaceMode, WorkspaceLayout>;
  setLayout: (mode: WorkspaceMode, patch: Partial<WorkspaceLayout>) => void;
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
  mergeShowBase: boolean;
  validationCommands: Record<string, string[]>;
  diffFullFile: boolean;
  /** Enables hourly update checks. The startup check always runs. */
  checkUpdates: boolean;
  /** Background fetch interval in minutes; 0 turns it off. */
  autoFetchMinutes: number;
  prPollMinutes: number;
  prWatchMineSince: number | null;
  prAllRepositories: boolean;
  prWatches: PullRequestWatches;
  /** Graph, stacked Review, or commit/file/diff columns. */
  historyMode: HistoryMode;
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
      showWhitespace: false,
      contextLines: 3,
      dateStyle: "relative",
      confirmDiscard: true,
      showRemoteBranchesInGraph: true,
      hideIncomingByRepo: {},
      primaryBranchByRepo: {},
      wrapDiff: false,
      recent: [],
      openTabs: [],
      openLibraryOnStartup: true,
      activeTab: null,
      explorerOpen: true,
      repositoryActionsCollapsed: false,
      explorerFavoritesOnly: false,
      layouts: restoreWorkspaceLayouts(),
      setLayout: (mode, patch) => set((state) => ({ layouts: { ...state.layouts, [mode]: { ...state.layouts[mode], ...patch } } })),
      pullMode: "ff-only",
      commitGraphDismissed: [],
      avatars: false,
      fileView: "list",
      graphWidth: 0,
      graphColumns: { author: true, date: true, hash: true },
      largeFileMb: 20,
      conventionalCommits: false,
      shortcuts: {},
      onboarded: false,
      syncScroll: true,
      mergeShowBase: true,
      validationCommands: {},
      diffFullFile: false,
      checkUpdates: true,
      autoFetchMinutes: 5,
      prPollMinutes: 5,
      prWatchMineSince: null,
      prAllRepositories: false,
      prWatches: {},
      historyMode: "graph",
      skippedUpdate: null,
      set: (patch) => set(patch),
      addRecent: (path) => set({ recent: [path, ...get().recent.filter((p) => p.toLowerCase() !== path.toLowerCase())].slice(0, 100) }),
      removeRecent: (path) => set({ recent: get().recent.filter((p) => p !== path) }),
    }),
    {
      name: "revqora.settings", version: 2,
      migrate: (stored) => ({ ...(stored as object), layouts: restoreWorkspaceLayouts(stored) }),
      merge: (stored, current) => {
        const { workspacesOpen: _workspacesOpen, groupsOpen: _groupsOpen, groupsWidth: _groupsWidth, workspaceFavoritesOnly, ...old } =
          (stored ?? {}) as Partial<Settings> & { workspacesOpen?: boolean; groupsOpen?: boolean; groupsWidth?: number; workspaceFavoritesOnly?: boolean; prWatches?: Record<string, Record<string, PullRequestWatch & { mineSince?: number }>> };
        const { groupsPanel, "window-workspaces": workspaceWindow, "workspace-create": workspaceCreate, ...shortcuts } = old.shortcuts ?? {};
        if (shortcuts.workspacesPanel === undefined && groupsPanel !== undefined) shortcuts.workspacesPanel = groupsPanel;
        if (shortcuts["window-explorer"] === undefined && workspaceWindow !== undefined) shortcuts["window-explorer"] = workspaceWindow;
        if (shortcuts["group-create"] === undefined && workspaceCreate !== undefined) shortcuts["group-create"] = workspaceCreate;
        const watches = Object.entries(old?.prWatches ?? {}).map(([root, scopes]) => [root, Object.entries(scopes ?? {})] as const);
        const legacyMine = watches.some(([, scopes]) => scopes.some(([, watch]) => !!watch?.mineSince));
        const prWatches = Object.fromEntries(watches.flatMap(([root, scopes]) => {
          const individual = scopes.flatMap(([scope, watch]) => Object.keys(watch?.selected ?? {}).length ? [[scope, { selected: watch.selected }]] : []);
          return individual.length ? [[root, Object.fromEntries(individual)]] : [];
        }));
        return {
          ...current, ...old, prWatches, shortcuts, explorerFavoritesOnly: old.explorerFavoritesOnly ?? workspaceFavoritesOnly ?? false, layouts: restoreWorkspaceLayouts(stored),
          prWatchMineSince: old?.prWatchMineSince !== undefined ? old.prWatchMineSince : legacyMine ? Date.now() : null,
        };
      },
    },
  ),
);

export function resolvedTheme(pref: ThemePref): "dark" | "light" {
  if (pref === "system") return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  return pref;
}
