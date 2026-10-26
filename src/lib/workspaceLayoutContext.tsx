import { createContext, useContext } from "react";
import { useSettings } from "./settings";
import type { WorkspaceLayout, WorkspaceMode } from "./workspaceLayouts";

export const WorkspaceLayoutContext = createContext<WorkspaceMode>("graph");

export function useWorkspaceLayout(override?: WorkspaceMode) {
  const context = useContext(WorkspaceLayoutContext);
  const mode = override ?? context;
  const layout = useSettings((s) => s.layouts[mode]);
  const setLayout = (patch: Partial<WorkspaceLayout>) => useSettings.getState().setLayout(mode, patch);
  return { mode, layout, setLayout };
}
