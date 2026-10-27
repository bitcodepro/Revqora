export type HistoryMode = "graph" | "review" | "columns";
export type WorkspaceMode = HistoryMode | "changes" | "pulls" | "overview";

export interface WorkspaceLayout {
  repositoriesOpen: boolean;
  repositoriesWidth: number;
  branchesOpen: boolean;
  sidebarWidth: number;
  commitFilesWidth: number;
  detailsHeight: number;
  changesListWidth: number;
  reviewListHeight: number;
  historyListWidth: number;
  focusMode: boolean;
}

export const HISTORY_MODES: HistoryMode[] = ["graph", "review", "columns"];
const MODES: WorkspaceMode[] = [...HISTORY_MODES, "changes", "pulls", "overview"];
const DEFAULT_LAYOUT: WorkspaceLayout = {
  repositoriesOpen: true, repositoriesWidth: 224, branchesOpen: true, sidebarWidth: 264,
  commitFilesWidth: 240, detailsHeight: 340, changesListWidth: 360,
  reviewListHeight: 220, historyListWidth: 300, focusMode: false,
};

function layoutValues(value: unknown): Partial<WorkspaceLayout> {
  if (!value || typeof value !== "object") return {};
  const values = value as Record<string, unknown>;
  return Object.fromEntries(Object.entries(DEFAULT_LAYOUT).filter(([key, fallback]) => {
    const candidate = values[key];
    return typeof fallback === "boolean" ? typeof candidate === "boolean" : typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0;
  }).map(([key]) => [key, values[key]]));
}

/** Migrate old shared widths without losing existing preferences or partial profiles. */
export function restoreWorkspaceLayouts(stored: unknown = {}): Record<WorkspaceMode, WorkspaceLayout> {
  const data = (stored && typeof stored === "object" ? stored : {}) as Record<string, unknown>;
  const legacy = layoutValues(data);
  const profiles = (data.layouts && typeof data.layouts === "object" ? data.layouts : {}) as Record<string, unknown>;
  return Object.fromEntries(MODES.map((mode) => [mode, { ...DEFAULT_LAYOUT, ...legacy, ...layoutValues(profiles[mode]) }])) as Record<WorkspaceMode, WorkspaceLayout>;
}

export function workspaceMode(view: string | undefined, history: HistoryMode): WorkspaceMode {
  return view === "changes" || view === "pulls" || view === "overview" ? view : history;
}
