import type { RefsSnapshot } from "./types";

export interface RemoteBranchTarget {
  label: string;
  remote: string;
  branch: string;
}

/** Offer the tracked branch first, including upstreams with a different name. */
export function deletionTargets(refs: RefsSnapshot, localName: string): RemoteBranchTarget[] {
  const upstream = refs.local.find((b) => b.name === localName)?.upstream;
  return refs.remote.flatMap((ref) => {
    const matches = refs.remotes.filter((r) => ref.name.startsWith(r.name + "/"));
    // Overlapping remote namespaces cannot identify a destructive target reliably.
    if (matches.length !== 1) return [];
    const remote = matches[0];
    const branch = ref.name.slice(remote.name.length + 1);
    return branch === localName || ref.name === upstream ? [{ label: ref.name, remote: remote.name, branch }] : [];
  }).sort((a, b) => Number(b.label === upstream) - Number(a.label === upstream) || a.label.localeCompare(b.label));
}
