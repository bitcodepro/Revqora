import { matchesBranchCreator } from "./branchManager";
import { branchPairs } from "./branchPresentation";
import type { BranchInfo, RefsSnapshot } from "./types";

export function selectExplorerBranches(refs: RefsSnapshot, options: {
  primary?: string;
  favorites?: string[];
  favoritesOnly: boolean;
  myBranchesOnly: boolean;
  authorQuery: string;
}) {
  const { primary, favorites, favoritesOnly, myBranchesOnly, authorQuery } = options;
  const starred = new Set(favorites);
  const show = (branch: BranchInfo) =>
    (!favoritesOnly || starred.has(branch.fullName)) &&
    (!myBranchesOnly || branch.fullName === primary || matchesBranchCreator(branch, authorQuery, refs.identityEmail ?? null));
  const local = refs.local.filter(show);
  const pairs = branchPairs(local, refs.remote);
  const paired = new Set([...pairs.upstreams.values()].map(branch => branch.fullName));
  const remote = refs.remote.filter(branch => show(branch) &&
    (branch.fullName === primary || starred.has(branch.fullName) || !paired.has(branch.fullName)));
  const rows = [...local, ...remote].sort((a, b) =>
    Number(b.fullName === primary) - Number(a.fullName === primary) ||
    Number(b.isHead) - Number(a.isHead) ||
    Number(!!a.remote) - Number(!!b.remote) ||
    a.name.localeCompare(b.name));
  return { rows, upstreams: pairs.upstreams };
}
