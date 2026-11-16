/** The fully qualified ref of a branch shown by its short name. Git resolves a short name to a
 *  local branch first, so `origin/feature` would mean a local branch called `origin/feature`
 *  when one exists; operations pass this instead and keep the short name for display. */
export function branchRef(kind: "local" | "remote", name: string): string {
  return `refs/${kind === "local" ? "heads" : "remotes"}/${name}`;
}
