import { repositoryKey, useLibrary, type LibraryData, type RepositoryPlacement } from "./repositoryLibrary";
import { findExplorerDrop, useLibraryPointerDrag } from "./libraryDrag";
import { toast } from "./ui";

type ExplorerOrder = Pick<LibraryData, "groups" | "knownRoots" | "explorerOrder" | "manuallyPlacedRoots">;
const history: { before: ExplorerOrder; after: ExplorerOrder }[] = [];
const order = ({ groups, knownRoots, explorerOrder, manuallyPlacedRoots }: ExplorerOrder): ExplorerOrder =>
  ({ groups, knownRoots, explorerOrder, manuallyPlacedRoots });
const sameOrder = (a: ExplorerOrder | undefined, b: ExplorerOrder) => !!a && a.groups === b.groups && a.knownRoots === b.knownRoots
  && a.explorerOrder === b.explorerOrder && a.manuallyPlacedRoots === b.manuallyPlacedRoots;

export function recordExplorerMove(move: () => void) {
  const before = order(useLibrary.getState());
  move();
  const after = order(useLibrary.getState());
  if (sameOrder(before, after)) return;
  if (!sameOrder(history.at(-1)?.after, before)) history.length = 0;
  history.push({ before, after });
  if (history.length > 20) history.shift();
}

export function undoExplorerMove() {
  const move = history.at(-1);
  if (!move || !sameOrder(move.after, useLibrary.getState())) return false;
  useLibrary.setState(move.before);
  history.pop();
  return true;
}

export function useRepositoryDrag() {
  const drag = useLibraryPointerDrag();
  return {
    suppressClick: drag.suppressClick,
    start(event: React.PointerEvent<HTMLButtonElement>, repositories: RepositoryPlacement[]) {
      if (!event.currentTarget.ownerDocument.querySelector("[data-tree-group]")) return;
      const keys = new Set(repositories.map(({ root }) => repositoryKey(root)));
      const findTarget = findExplorerDrop(useLibrary.getState().groups, new Set(), keys);
      drag.start(event, keys.size === 1 ? "Move repository" : `Move ${keys.size} repositories`, findTarget, ({ parentId, placement }) => {
        try { recordExplorerMove(() => useLibrary.getState().moveRepositories(repositories, parentId, placement)); }
        catch (error) { toast.error(error); }
      });
    },
  };
}
