import { useSettings } from "./settings";
import { useRepos } from "./store";
import { uniqueRoots, useLibrary, type SavedWorkspace } from "./repositoryLibrary";

export function startupRepositoryRoots(openTabs: string[], knownRoots: string[], openLibrary: boolean, workspace?: Pick<SavedWorkspace, "roots">) {
  return uniqueRoots(workspace?.roots ?? (openLibrary ? [...openTabs, ...knownRoots] : openTabs));
}

let restoring: Promise<PromiseSettledResult<string | null>[]> | undefined;

/** Run before React mounts: external-store subscriptions are not installed during
 * the initial render. Restoring in an effect briefly paints Welcome/Closed rows.
 * Calling this again from StrictMode startup reuses the same restoration.
 */
export function restoreRepositorySession() {
  if (!restoring) {
    const { openTabs, activeTab, openLibraryOnStartup } = useSettings.getState();
    const { knownRoots, workspaces, activeWorkspaceId } = useLibrary.getState();
    const workspace = workspaces.find((item) => item.id === activeWorkspaceId);
    restoring = useRepos.getState().openMany(startupRepositoryRoots(openTabs, knownRoots, openLibraryOnStartup, workspace), workspace ? workspace.activeRoot : activeTab);
  }
  return restoring;
}
