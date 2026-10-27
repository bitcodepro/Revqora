import { afterEach, describe, expect, it } from "vitest";
import backend from "../../src-tauri/src/lib.rs?raw";
import { MUTATING_COMMANDS, repositoryCall, setOperationHooks, type Invoke } from "./operationClient";
import type { RepoInfo, StatusSummary } from "./types";

afterEach(() => setOperationHooks({ observed: () => null, refreshed: () => {} }));

function fixture(options: { stale?: boolean; refreshFails?: boolean } = {}) {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const refreshed: string[] = [];
  let observed = "displayed";
  const error = { kind: "stale-operation", message: "Review the new state" };
  setOperationHooks({ observed: () => observed, refreshed: (_repo, status) => { observed = status.stateToken!; refreshed.push(observed); } });
  const invoke: Invoke = async <T>(cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    if (cmd === "status") {
      if (options.refreshFails) throw new Error("refresh unavailable");
      return { stateToken: "fresh" } as T;
    }
    if (cmd === "repo_info") return {} as T;
    if (options.stale) throw error;
    return "done" as T;
  };
  return { calls, invoke, refreshed, error };
}

describe("repository operation client", () => {
  it("passes reads through without queue preconditions", async () => {
    const f = fixture();
    await repositoryCall(f.invoke, "refs_snapshot", { repo: "repo" });
    expect(f.calls).toEqual([{ cmd: "refs_snapshot", args: { repo: "repo" } }]);
  });
  it("commits keep the displayed staged state rather than accepting unseen external changes", async () => {
    const f = fixture();
    await repositoryCall(f.invoke, "commit", { repo: "repo", message: "Commit" });
    expect(f.calls[0]).toEqual({ cmd: "commit", args: { repo: "repo", message: "Commit", expectedState: "displayed" } });
    expect(f.refreshed).toEqual(["fresh"]);
  });
  it("refreshes between compound actions so they do not reject their own changes", async () => {
    const f = fixture();
    await repositoryCall(f.invoke, "commit", { repo: "repo" });
    await repositoryCall(f.invoke, "push", { repo: "repo" });
    expect(f.calls.find((c) => c.cmd === "push")?.args?.expectedState).toBe("fresh");
  });
  it("preserves a dialog's captured precondition even after the underlying UI refreshed", async () => {
    const f = fixture();
    await repositoryCall(f.invoke, "reset", { repo: "repo", expectedState: "dialog-opened" });
    expect(f.calls[0].args?.expectedState).toBe("dialog-opened");
  });
  it("commands with immutable targets capture fresh state before entering the queue", async () => {
    const f = fixture();
    await repositoryCall(f.invoke, "restore_branch", { repo: "repo", name: "restored", oid: "explicit-sha" });
    expect(f.calls.find((c) => c.cmd === "restore_branch")?.args?.expectedState).toBe("fresh");
  });
  it("a fresh request snapshot cannot silently switch the destination branch", async () => {
    const f = fixture();
    setOperationHooks({ observed: () => "old", observedHead: () => ({ branch: "main", oid: "old" }), refreshed: () => {} });
    await expect(repositoryCall(f.invoke, "cherry_pick", { repo: "repo" })).rejects.toMatchObject({ kind: "stale-operation" });
    expect(f.calls.some((c) => c.cmd === "cherry_pick")).toBe(false);
  });
  it("propagates stale errors without retrying and refreshes for the next user decision", async () => {
    const f = fixture({ stale: true });
    await expect(repositoryCall(f.invoke, "reset", { repo: "repo" })).rejects.toEqual(f.error);
    expect(f.calls.filter((c) => c.cmd === "reset")).toHaveLength(1);
    expect(f.refreshed).toEqual(["fresh"]);
  });
  it("does not report a successful mutation as failed when the following refresh fails", async () => {
    const f = fixture({ refreshFails: true });
    await expect(repositoryCall(f.invoke, "commit", { repo: "repo" })).resolves.toBe("done");
  });
  it("background fetch is serialized without depending on an obsolete UI state", async () => {
    const f = fixture();
    await repositoryCall(f.invoke, "fetch_background", { repo: "repo" });
    expect(f.calls[0].args?.expectedState).toBeNull();
  });
  it("keeps dependent actions pending until the post-operation state is refreshed", async () => {
    const pending: number[] = [];
    let release!: (value: StatusSummary) => void;
    const status = new Promise<StatusSummary>((resolve) => { release = resolve; });
    setOperationHooks({ observed: () => "displayed", refreshed: () => {}, pending: (_repo, delta) => pending.push(delta) });
    const invoke: Invoke = async <T>(cmd: string) => (cmd === "status" ? await status : {}) as T;
    const result = repositoryCall(invoke, "stage", { repo: "repo" });
    await Promise.resolve();
    expect(pending).toEqual([1]);
    release({ stateToken: "fresh" } as StatusSummary);
    await result;
    expect(pending).toEqual([1, -1]);
  });
  it("gets a baseline when no displayed repository state exists", async () => {
    const calls: string[] = [];
    setOperationHooks({ observed: () => null, refreshed: (_repo: string, _status: StatusSummary, _info: RepoInfo) => {} });
    const invoke: Invoke = async <T>(cmd: string, args?: Record<string, unknown>) => {
      calls.push(cmd);
      if (cmd === "status") return { stateToken: "baseline" } as T;
      if (cmd === "stage") expect(args?.expectedState).toBe("baseline");
      return {} as T;
    };
    await repositoryCall(invoke, "stage", { repo: "repo" });
    expect(calls[0]).toBe("status");
  });
  it("keeps the client command registry in sync with transaction-wrapped backend commands", () => {
    const wrapped = [...backend.matchAll(/mutating\([\s\S]*?"([a-z_]+)"/g)].map((m) => m[1]);
    expect(new Set(wrapped)).toEqual(MUTATING_COMMANDS);
  });
});
