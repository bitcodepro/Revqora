import { useSettings } from "./settings";
import { useRepos } from "./store";
import { uniqueRoots, useLibrary } from "./repositoryLibrary";

export function startupRepositoryRoots(openTabs: string[], knownRoots: string[], openLibrary: boolean) {
  return uniqueRoots(openLibrary ? [...openTabs, ...knownRoots] : openTabs);
}

let restoring: Promise<PromiseSettledResult<string | null>[]> | undefined;

/** Run before React mounts: external-store subscriptions are not installed during
 * the initial render. Restoring in an effect briefly paints Welcome/Closed rows.
 * Calling this again from StrictMode startup reuses the same restoration.
 */
export function restoreRepositorySession() {
  if (!restoring) {
    const { openTabs, activeTab, openLibraryOnStartup } = useSettings.getState();
    const { knownRoots } = useLibrary.getState();
    restoring = useRepos.getState().openMany(startupRepositoryRoots(openTabs, knownRoots, openLibraryOnStartup), activeTab);
  }
  return restoring;
}
