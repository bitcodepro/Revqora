import { describe, expect, it, vi } from "vitest";
import type { BranchInfo, RefsSnapshot } from "./types";

const synced: unknown[][] = [];
const pulled: unknown[][] = [];
vi.mock("./remoteSync", () => ({ syncRepositories: (...args: unknown[]) => { synced.push(args); return Promise.resolve(); } }));
vi.mock("./actions", async (original) => ({
  ...(await original<typeof import("./actions")>()),
  pullBranch: (...args: unknown[]) => { pulled.push(args); return Promise.resolve(); },
}));

const { branchMenu } = await import("../components/menus");

const branch = (name: string, extra: Partial<BranchInfo> = {}): BranchInfo => ({
  name, fullName: `refs/heads/${name}`, oid: "a".repeat(40), upstream: `origin/${name}`, upstreamFullName: `refs/remotes/origin/${name}`,
  ahead: 0, behind: 0, gone: false, isHead: false, remote: "origin", time: 0, subject: "", author: "", ...extra,
});
const refs: RefsSnapshot = {
  local: [branch("main", { isHead: true }), branch("feature"), branch("draft", { upstream: null, upstreamFullName: null, remote: null })],
  remote: [], tags: [], stashes: [], remotes: [{ name: "origin" } as RefsSnapshot["remotes"][number]],
};
const item = (name: string, label: string) => branchMenu("/repo", name, "local", refs).find(entry => entry.label === label);

describe("Fetch, Pull and Push on a branch", () => {
  it("work on a branch that is not checked out, without a checkout", () => {
    synced.length = 0;
    for (const label of ["Fetch", "Pull", "Push"]) item("feature", label)!.onClick!();
    expect(synced).toEqual(["fetch", "pull", "push"].map(kind => [kind, [{ root: "/repo", branches: ["refs/heads/feature"] }]]));
  });

  it("keep the regular Pull and the Push dialog for the checked-out branch", () => {
    synced.length = 0;
    pulled.length = 0;
    item("main", "Pull")!.onClick!();
    expect(pulled).toEqual([["/repo", { branch: "main", upstream: "origin/main" }]]);
    expect(item("main", "Push…")).toBeDefined();
    expect(synced).toEqual([]);
  });

  it("explain why a branch without an upstream cannot be pulled or pushed", () => {
    expect(item("draft", "Pull")).toMatchObject({ disabled: true, hint: "Set an upstream first" });
    expect(item("draft", "Push")).toMatchObject({ disabled: true, hint: "Set an upstream first" });
  });
});
