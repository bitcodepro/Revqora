/** The fully qualified ref of a branch shown by its short name. Git resolves a short name to a
 *  local branch first, so `origin/feature` would mean a local branch called `origin/feature`
 *  when one exists; operations pass this instead and keep the short name for display. */
export function branchRef(kind: "local" | "remote", name: string): string {
  return `refs/${kind === "local" ? "heads" : "remotes"}/${name}`;
}

export interface KnownRefs {
  local: { name: string }[];
  remote: { name: string }[];
  tags: { name: string }[];
}

/**
 * The argument to give Git for a branch ref. Git writes the argument into the default merge
 * message ("Merge branch 'x'", "Merge remote-tracking branch 'origin/x'"), so the short name is
 * used whenever Git resolves it to the same branch: no tag of that name and, for a
 * remote-tracking branch, no local branch of that name. Otherwise the full ref is kept, since
 * the short name would select a different object.
 */
export function gitBranchArg(ref: string, known: KnownRefs | null | undefined): string {
  const local = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : null;
  const remote = ref.startsWith("refs/remotes/") ? ref.slice("refs/remotes/".length) : null;
  const short = local ?? remote;
  if (!short || !known) return ref;
  if (known.tags.some(tag => tag.name === short)) return ref;
  if (remote && known.local.some(branch => branch.name === short)) return ref;
  return short;
}
