import { useRepos } from "./store";
import { closeOwnedOverlay, toast, type OverlayOwner } from "./ui";

let latestOpen = 0;

/** Managers can dismiss their own navigation and agent results can open Changes. */
export async function openWorktree(path: string, owner?: OverlayOwner, view?: "changes"): Promise<void> {
  const request = ++latestOpen;
  try {
    const root = await useRepos.getState().open(path);
    if (request === latestOpen) {
      if (view && root) useRepos.getState().patch(root, { view });
      if (owner) closeOwnedOverlay(owner);
    }
  } catch (e) {
    toast.error(e, "Could not open worktree");
  }
}
