import { describe, expect, it } from "vitest";
import { pullBlockReason, runRepositoryBatch, type BatchDeps, type RepositorySnapshot } from "./repositoryBatch";
import type { RepoInfo, StatusSummary } from "./types";

const info: RepoInfo = {
  root: "/repo", gitDir: "/repo/.git", name: "repo", isBare: false,
  head: { branch: "main", oid: "abc", detached: false, unborn: false },
  state: { kind: "none", incoming: null, incomingLabel: null, message: null, step: null, total: null, headName: null, onto: null, stoppedAt: null },
};
const status: StatusSummary = { branch: "main", oid: "abc", upstream: "origin/main", ahead: 0, behind: 3, files: [], stagedCount: 0, unstagedCount: 0, conflictCount: 0 };
const clean = (): RepositorySnapshot => ({ info: structuredClone(info), status: structuredClone(status) });

describe("bulk fast-forward eligibility", () => {
  it("only accepts clean, attached branches with incoming commits and an upstream", () => {
    expect(pullBlockReason(clean())).toBeNull();
    for (const patch of [
      { upstream: null }, { ahead: 1 }, { behind: 0 }, { conflictCount: 1 },
      { files: [{ path: "new.txt", origPath: null, index: "?", worktree: "?", conflict: null, untracked: true, submodule: false }] },
      { branch: "other" }, { oid: "changed" },
    ]) expect(pullBlockReason({ info, status: { ...status, ...patch } })).not.toBeNull();
    expect(pullBlockReason({ info: null, status: null })).not.toBeNull();
    expect(pullBlockReason({ info: { ...info, isBare: true }, status })).not.toBeNull();
    expect(pullBlockReason({ info: { ...info, head: { ...info.head, detached: true } }, status })).not.toBeNull();
    expect(pullBlockReason({ info: { ...info, state: { ...info.state, kind: "merge" } }, status })).not.toBeNull();
  });
});

describe("repository batches", () => {
  it("rechecks each repository, skips changed state, and continues after an error", async () => {
    const pulled: string[] = [], refreshed: string[] = [];
    const deps: BatchDeps = {
      read: async (root) => root === "dirty" ? { info, status: { ...status, conflictCount: 1 } } : clean(),
      fetch: async () => {},
      pull: async (root) => { pulled.push(root); if (root === "offline") throw new Error("Network unavailable"); },
      refresh: async (root) => { refreshed.push(root); },
      isOpen: (root) => root !== "closed",
      progress: () => {},
    };
    const results = await runRepositoryBatch(["dirty", "offline", "ready", "closed", "ready"], "pull", deps);
    expect(pulled).toEqual(["offline", "ready"]);
    expect(results.map((r) => r.status)).toEqual(["skipped", "failed", "done", "skipped"]);
    expect(refreshed).toEqual(["dirty", "offline", "ready", "closed"]);
  });
  it("fetches without changing working copies and keeps failures in the result", async () => {
    const fetched: string[] = [];
    const results = await runRepositoryBatch(["a", "b"], "fetch", {
      read: async () => { throw new Error("Fetch does not need a pull preflight"); },
      fetch: async (r) => { fetched.push(r); if (r === "a") throw { message: "Authentication failed" }; },
      pull: async () => { throw new Error("Never pull during fetch"); },
      refresh: async () => {},
      isOpen: () => true,
      progress: () => {},
    });
    expect(fetched).toEqual(["a", "b"]);
    expect(results).toMatchObject([{ status: "failed", message: "Authentication failed" }, { status: "done" }]);
  });
});
