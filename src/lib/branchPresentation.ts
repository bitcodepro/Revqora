import type { BranchInfo } from "./types";

/** Pair configured full refs, including differently named branches and custom refspecs. */
export function branchPairs(local: BranchInfo[], remote: BranchInfo[]) {
  const byRef = new Map(remote.map(b => [b.fullName, b]));
  const upstreams = new Map(local.flatMap(b => {
    const upstream = b.upstreamFullName && !b.gone ? byRef.get(b.upstreamFullName) : undefined;
    return upstream ? [[b.fullName, upstream] as const] : [];
  }));
  const paired = new Set([...upstreams.values()].map(b => b.fullName));
  return { upstreams, remoteOnly: remote.filter(b => !paired.has(b.fullName)) };
}

export function branchConnection(b: BranchInfo) {
  const remote = b.upstreamFullName?.startsWith("refs/remotes/");
  if (remote && b.gone) return { kind: "gone", title: `Remote deleted · ${b.upstream}. The local branch is preserved. Counts reflect the last Fetch.` } as const;
  if (remote) return { kind: "paired", title: `Local + remote · tracks ${b.upstream}. ↑ commits to push; ↓ commits to pull. Counts reflect the last Fetch.` } as const;
  return { kind: "local", title: b.upstreamFullName ? `Local tracking · ${b.upstream}${b.gone ? " (missing)" : ""}` : "Local only · no upstream configured." } as const;
}
