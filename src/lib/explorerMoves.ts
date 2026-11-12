import { repositoryKey, useLibrary, type LibraryData, type RepositoryDropPlacement, type RepositoryPlacement } from "./repositoryLibrary";
import { dropEdge, findExplorerDropElement, useLibraryPointerDrag } from "./libraryDrag";

type ExplorerOrder = Pick<LibraryData, "groups" | "knownRoots">;
const history: { before: ExplorerOrder; after: ExplorerOrder }[] = [];
const order = ({ groups, knownRoots }: ExplorerOrder): ExplorerOrder => ({ groups, knownRoots });
const sameOrder = (a: ExplorerOrder | undefined, b: ExplorerOrder) => !!a && a.groups === b.groups && a.knownRoots === b.knownRoots;

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

interface RepositoryDestination { groupId: string | null; placement?: RepositoryDropPlacement }

export function useRepositoryDrag() {
  const drag = useLibraryPointerDrag();
  return {
    suppressClick: drag.suppressClick,
    start(event: React.PointerEvent<HTMLButtonElement>, repositories: RepositoryPlacement[]) {
      if (!event.currentTarget.ownerDocument.querySelector("[data-tree-group]")) return;
      const keys = new Set(repositories.map(({ root }) => repositoryKey(root)));
      drag.start(event, keys.size === 1 ? "Move repository" : `Move ${keys.size} repositories`, (hit, y) => {
        const element = findExplorerDropElement(hit, y);
        if (!element) return null;
        const siblingRoot = element.dataset.explorerRepository;
        const groupId = (siblingRoot ? element.dataset.repositoryParent : element.dataset.treeGroup) || null;
        if (siblingRoot) {
          if (keys.has(repositoryKey(siblingRoot))) return null;
          const position = dropEdge(element, y, 0.5)!;
          return { element, position, hint: `Insert ${position} ${element.getAttribute("aria-label")}`,
            value: { groupId, placement: { siblingRoot, after: position === "after" } } };
        }
        if (repositories.every(item => item.groupId === groupId)) return null;
        return { element, value: { groupId }, hint: groupId ? `Move into ${element.getAttribute("aria-label")}` : "Move to top level" };
      }, ({ groupId, placement }: RepositoryDestination) =>
        recordExplorerMove(() => useLibrary.getState().moveRepositories(repositories, groupId, placement)));
    },
  };
}
