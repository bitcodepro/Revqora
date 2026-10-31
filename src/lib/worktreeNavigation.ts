import { useRepos } from "./store";
import { closeOwnedOverlay, toast, type OverlayOwner } from "./ui";

let latestOpen = 0;

/** Toast actions open a tab only. Manager callers can dismiss their own navigation. */
export async function openWorktree(path: string, owner?: OverlayOwner): Promise<void> {
  const request = ++latestOpen;
  try {
    await useRepos.getState().open(path);
    if (owner && request === latestOpen) closeOwnedOverlay(owner);
  } catch (e) {
    toast.error(e, "Could not open worktree");
  }
}
