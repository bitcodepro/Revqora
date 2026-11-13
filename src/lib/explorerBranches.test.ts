import { describe, expect, it } from "vitest";
import { selectExplorerBranches } from "./explorerBranches";
import type { BranchInfo, RefsSnapshot } from "./types";

function branch(name: string, options: Partial<BranchInfo> = {}): BranchInfo {
  return {
    name, fullName: "refs/heads/" + name, oid: "a", upstream: null, upstreamFullName: null,
    ahead: 0, behind: 0, gone: false, isHead: false, remote: null,
    time: 1, subject: "Fixture", author: "Me", authorEmail: "me@example.test", creator: null,
    ...options,
  };
}

const primary = branch("team/base", { creator: { name: "Team", email: "team@example.test" } });
const upstream = branch("origin/topic", { fullName: "refs/remotes/origin/topic", remote: "origin" });
const topic = branch("topic", { creator: { name: "Me", email: "ME@example.test" }, upstreamFullName: upstream.fullName });
const current = branch("main", { isHead: true });
const refs: RefsSnapshot = { identityEmail: "me@example.test", local: [topic, current, primary], remote: [upstream], tags: [], stashes: [], remotes: [] };
const options = { primary: primary.fullName, authorQuery: "", favoritesOnly: false, myBranchesOnly: false };
const names = (filters: Partial<typeof options> & { favorites?: string[] }) =>
  selectExplorerBranches(refs, { ...options, ...filters }).rows.map(item => item.fullName);

describe("Explorer branch filters", () => {
  it("pins primary, then the checked-out branch, and folds a paired upstream into the local row", () => {
    expect(names({})).toEqual([primary.fullName, current.fullName, topic.fullName]);
    expect(selectExplorerBranches(refs, options).upstreams.get(topic.fullName)).toBe(upstream);
  });

  it("uses recorded creators, keeps primary in My branches, and combines both filters", () => {
    expect(names({ myBranchesOnly: true })).toEqual([primary.fullName, topic.fullName]);
    expect(names({ myBranchesOnly: true, favoritesOnly: true, favorites: [topic.fullName, current.fullName] })).toEqual([topic.fullName]);
  });

  it("shows an explicitly favorited or primary upstream as its own row", () => {
    expect(names({ favoritesOnly: true, favorites: [upstream.fullName] })).toEqual([upstream.fullName]);
    expect(names({ primary: upstream.fullName, myBranchesOnly: true })).toEqual([upstream.fullName, topic.fullName]);
  });
});
