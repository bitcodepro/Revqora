import { useLibrary, type RepositoryGroup, type RepositoryPlacement } from "./repositoryLibrary";
import { useLibraryPointerDrag } from "./libraryDrag";

const history: { before: RepositoryGroup[]; after: RepositoryGroup[] }[] = [];

export function recordExplorerMove(move: () => void) {
  const before = useLibrary.getState().groups;
  move();
  const after = useLibrary.getState().groups;
  if (before === after) return;
  if (history.at(-1)?.after !== before) history.length = 0;
  history.push({ before, after });
  if (history.length > 20) history.shift();
}

export function undoExplorerMove() {
  const move = history.at(-1);
  if (!move || useLibrary.getState().groups !== move.after) return false;
  useLibrary.setState({ groups: move.before });
  history.pop();
  return true;
}

export function useRepositoryDrag() {
  const drag = useLibraryPointerDrag();
  return {
    suppressClick: drag.suppressClick,
    start(event: React.PointerEvent<HTMLButtonElement>, repositories: RepositoryPlacement[]) {
      if (!event.currentTarget.ownerDocument.querySelector("[data-tree-group]")) return;
      const count = new Set(repositories.map(({ root }) => root)).size;
      drag.start(event, count === 1 ? "Move repository" : `Move ${count} repositories`, hit => {
        const element = hit?.closest<HTMLElement>("[data-tree-group]");
        const id = element?.dataset.treeGroup || null;
        return element && repositories.some(item => item.groupId !== id) ? { element, value: id } : null;
      }, id => recordExplorerMove(() => useLibrary.getState().moveRepositories(repositories, id)));
    },
  };
}
