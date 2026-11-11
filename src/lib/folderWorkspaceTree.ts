import { repositoryKey, type FolderWorkspace } from "./repositoryLibrary";
import type { FoundRepository } from "./types";

function separator(path: string) {
  return /^[a-z]:[\\/]|^(?:\\\\|\/\/)/i.test(path) ? /[\\/]/ : /\//;
}

function parentFolder(path: string): string {
  const windows = separator(path).test("\\");
  const slash = windows ? Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) : path.lastIndexOf("/");
  if (slash === 0 || windows && slash === 2 && path[1] === ":") return path.slice(0, slash + 1);
  return slash < 0 ? path : path.slice(0, slash);
}

/** Keep each directory on the selected path to a repository, including empty intermediate nodes. */
export function folderWorkspaceTree(repositories: FoundRepository[], selected: ReadonlySet<string>): FolderWorkspace[] {
  const folders = new Map<string, FolderWorkspace>();
  for (const repo of repositories) {
    if (!selected.has(repo.root)) continue;
    const parts = repo.relativePath.split(separator(repo.root)).filter(part => part && part !== ".");
    const parents = [parts.length ? repo.workspaceFolder ?? parentFolder(repo.root) : repo.root];
    for (let level = 1; level < parts.length; level++) parents.push(parentFolder(parents.at(-1)!));
    let parent: string | null = null;
    for (const folder of parents.reverse()) {
      const key = repositoryKey(folder);
      if (!folders.has(key)) folders.set(key, { folder, parentFolder: parent, roots: [] });
      parent = folder;
    }
    if (parent !== null) folders.get(repositoryKey(parent))!.roots.push(repo.root);
  }
  return [...folders.values()];
}
