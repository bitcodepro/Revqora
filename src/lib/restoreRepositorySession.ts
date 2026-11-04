import { useSettings } from "./settings";
import { useRepos } from "./store";

let restoring: Promise<PromiseSettledResult<string | null>[]> | undefined;

/** Run before React mounts: external-store subscriptions are not installed during
 * the initial render. Restoring in an effect briefly paints Welcome/Closed rows.
 * Calling this again from StrictMode startup reuses the same restoration.
 */
export function restoreRepositorySession() {
  if (!restoring) {
    const { openTabs, activeTab } = useSettings.getState();
    restoring = useRepos.getState().openMany(openTabs, activeTab);
  }
  return restoring;
}
