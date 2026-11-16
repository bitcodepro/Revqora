import { describe, expect, it } from "vitest";
import { dragItemLabel, graphDropActions, type DragItem, type DropAction, type DropRepoState, type DropTarget } from "./graphDrop";

const oid = (c: string) => c.repeat(40);

/** `main` is checked out and tracks origin/main; `feature` tracks origin/feature; `topic` has no upstream. */
const repo = (over: Partial<DropRepoState> = {}): DropRepoState => ({
  head: "main",
  operation: "none",
  local: [
    { name: "main", oid: oid("a"), upstream: "origin/main", ahead: 0, behind: 0 },
    { name: "feature", oid: oid("b"), upstream: "origin/feature", ahead: 2, behind: 0 },
    { name: "topic", oid: oid("c"), upstream: null },
  ],
  remote: [
    { name: "origin/main", oid: oid("a") },
    { name: "origin/feature", oid: oid("d") },
    { name: "origin/other", oid: oid("e") },
  ],
  otherWorktreeBranches: [],
  ...over,
});

const local = (name: string) => ({ kind: "branch", scope: "local", name }) as const;
const remote = (name: string) => ({ kind: "branch", scope: "remote", name }) as const;
const commits = (...letters: string[]): DragItem => ({ kind: "commits", oids: letters.map(oid) });
const commit = (letter: string, subject = "Subject"): DropTarget => ({ kind: "commit", oid: oid(letter), subject });
const labels = (actions: DropAction[]) => actions.map(a => a.label);
const byId = (actions: DropAction[], id: DropAction["id"]) => actions.find(a => a.id === id)!;

describe("branch dropped on a local branch", () => {
  it("offers merge, rebase and compare with truthful switch labels when the target is current", () => {
    const actions = graphDropActions(local("feature"), local("main"), repo());
    expect(labels(actions)).toEqual([
      "Merge feature into main…",
      "Switch to feature and rebase it onto main",
      "Compare feature with main",
    ]);
    expect(byId(actions, "merge")).toMatchObject({ branch: "main", switches: false, run: { type: "merge", source: "refs/heads/feature", label: "feature" } });
    expect(byId(actions, "rebase")).toMatchObject({ branch: "feature", switches: true, run: { type: "rebase", onto: "refs/heads/main", label: "main" } });
    expect(byId(actions, "compare")).toMatchObject({ branch: null, switches: false, run: { type: "compare", from: "refs/heads/main", to: "refs/heads/feature" } });
    expect(actions.every(a => !a.disabled)).toBe(true);
  });

  it("switches to the target for a merge when the dragged branch is current", () => {
    const actions = graphDropActions(local("main"), local("feature"), repo());
    expect(labels(actions)).toEqual([
      "Switch to feature and merge main…",
      "Rebase main onto feature",
      "Compare main with feature",
    ]);
    expect(byId(actions, "merge")).toMatchObject({ branch: "feature", switches: true });
    expect(byId(actions, "rebase")).toMatchObject({ branch: "main", switches: false });
  });

  it("says that both sides need a switch when neither branch is current", () => {
    expect(labels(graphDropActions(local("feature"), local("topic"), repo()))).toEqual([
      "Switch to topic and merge feature…",
      "Switch to feature and rebase it onto topic",
      "Compare feature with topic",
    ]);
  });

  it("offers nothing for the same branch on both sides", () => {
    expect(graphDropActions(local("main"), local("main"), repo())).toEqual([]);
    expect(graphDropActions(remote("origin/main"), remote("origin/main"), repo())).toEqual([]);
  });

  it("disables merge and rebase with a reason when both branches point to the same commit", () => {
    const state = repo({ local: [{ name: "main", oid: oid("a") }, { name: "copy", oid: oid("a") }] });
    const actions = graphDropActions(local("copy"), local("main"), state);
    expect(byId(actions, "merge").disabled).toBe("copy and main point to the same commit");
    expect(byId(actions, "rebase").disabled).toBe("copy and main point to the same commit");
    expect(byId(actions, "compare").disabled).toBeUndefined();
  });

  it("a remote-tracking branch can be merged but never rebased", () => {
    const actions = graphDropActions(remote("origin/other"), local("main"), repo());
    expect(labels(actions)).toEqual(["Merge origin/other into main…", "Compare origin/other with main"]);
    expect(byId(actions, "merge").run).toEqual({ type: "merge", source: "refs/remotes/origin/other", label: "origin/other" });
  });

  it("names the dragged and target refs fully when a local branch shares a remote branch's name", () => {
    // A local branch called origin/feature and the remote-tracking origin/feature, at different commits.
    const state = repo({ local: [...repo().local, { name: "origin/feature", oid: oid("f") }] });
    const merge = byId(graphDropActions(remote("origin/feature"), local("main"), state), "merge");
    expect(merge.run).toEqual({ type: "merge", source: "refs/remotes/origin/feature", label: "origin/feature" });
    const fromLocal = byId(graphDropActions(local("origin/feature"), local("main"), state), "merge");
    expect(fromLocal.run).toEqual({ type: "merge", source: "refs/heads/origin/feature", label: "origin/feature" });
    const rebase = byId(graphDropActions(local("topic"), remote("origin/feature"), state), "rebase");
    expect(rebase.run).toEqual({ type: "rebase", onto: "refs/remotes/origin/feature", label: "origin/feature" });
    const rebaseLocal = byId(graphDropActions(local("topic"), local("origin/feature"), state), "rebase");
    expect(rebaseLocal.run).toEqual({ type: "rebase", onto: "refs/heads/origin/feature", label: "origin/feature" });
  });
});

describe("remote-tracking branch dropped on the local branch that tracks it", () => {
  it("offers Pull, then merge", () => {
    const state = repo({ local: [{ name: "main", oid: oid("a"), upstream: "origin/main", ahead: 1, behind: 2 }], remote: [{ name: "origin/main", oid: oid("f") }] });
    const actions = graphDropActions(remote("origin/main"), local("main"), state);
    expect(labels(actions)).toEqual(["Pull main from origin/main", "Merge origin/main into main…", "Compare origin/main with main"]);
    expect(byId(actions, "pull")).toMatchObject({ branch: "main", switches: false, run: { type: "pull", branch: "main", upstream: "origin/main", fastForwardOnly: false } });
  });

  it("offers Fast-forward first when the local branch is only behind", () => {
    const state = repo({ local: [{ name: "main", oid: oid("a"), upstream: "origin/main", ahead: 0, behind: 3 }], remote: [{ name: "origin/main", oid: oid("f") }] });
    const actions = graphDropActions(remote("origin/main"), local("main"), state);
    expect(labels(actions)).toEqual(["Fast-forward main to origin/main", "Pull main from origin/main", "Merge origin/main into main…", "Compare origin/main with main"]);
    expect(byId(actions, "fast-forward")).toMatchObject({ hint: "Pull, fast-forward only", run: { type: "pull", branch: "main", upstream: "origin/main", fastForwardOnly: true } });
  });

  it("does not claim a fast-forward when the branch is up to date or has its own commits", () => {
    const upToDate = graphDropActions(remote("origin/main"), local("main"), repo());
    expect(upToDate.some(a => a.id === "fast-forward")).toBe(false);
    // Pull stays available: the remote may have commits that were not fetched yet.
    expect(byId(upToDate, "pull").disabled).toBeUndefined();
    expect(byId(upToDate, "merge").disabled).toBe("origin/main and main point to the same commit");
    const diverged = repo({ local: [{ name: "main", oid: oid("a"), upstream: "origin/main", ahead: 1, behind: 3 }], remote: [{ name: "origin/main", oid: oid("f") }] });
    expect(graphDropActions(remote("origin/main"), local("main"), diverged).some(a => a.id === "fast-forward")).toBe(false);
  });

  it("names the switch when the tracking branch is not current", () => {
    const state = repo({ local: [{ name: "main", oid: oid("a") }, { name: "feature", oid: oid("b"), upstream: "origin/feature", ahead: 0, behind: 1 }] });
    expect(labels(graphDropActions(remote("origin/feature"), local("feature"), state))).toEqual([
      "Switch to feature and fast-forward it to origin/feature",
      "Switch to feature and pull from origin/feature…",
      "Switch to feature and merge origin/feature…",
      "Compare origin/feature with feature",
    ]);
  });

  it("offers no pull for a remote branch the target does not track", () => {
    expect(graphDropActions(remote("origin/other"), local("feature"), repo()).some(a => a.id === "pull" || a.id === "fast-forward")).toBe(false);
  });
});

describe("branch dropped on a remote-tracking branch", () => {
  it("offers Push for a local branch dropped on its upstream", () => {
    const actions = graphDropActions(local("feature"), remote("origin/feature"), repo());
    expect(labels(actions)).toEqual([
      "Switch to feature and push it to origin/feature…",
      "Switch to feature and rebase it onto origin/feature",
      "Compare feature with origin/feature",
    ]);
    expect(byId(actions, "push")).toMatchObject({ branch: "feature", switches: true, run: { type: "push" } });
    expect(labels(graphDropActions(local("feature"), remote("origin/feature"), repo({ head: "feature" })))[0]).toBe("Push feature to origin/feature…");
  });

  it("disables Push when there is nothing to push", () => {
    const actions = graphDropActions(local("main"), remote("origin/main"), repo());
    expect(byId(actions, "push").disabled).toBe("Nothing to push: main and origin/main point to the same commit");
  });

  it("offers no push to a remote branch that is not the upstream, and never a merge into it", () => {
    const actions = graphDropActions(local("topic"), remote("origin/other"), repo());
    expect(labels(actions)).toEqual(["Switch to topic and rebase it onto origin/other", "Compare topic with origin/other"]);
  });

  it("only compares two remote-tracking branches", () => {
    expect(labels(graphDropActions(remote("origin/feature"), remote("origin/main"), repo()))).toEqual(["Compare origin/feature with origin/main"]);
  });
});

describe("commits dropped on a branch", () => {
  it("cherry-picks onto the current branch in the given order", () => {
    const actions = graphDropActions(commits("x", "y", "z"), local("main"), repo());
    expect(labels(actions)).toEqual(["Cherry-pick 3 commits onto main"]);
    expect(actions[0]).toMatchObject({ id: "cherry-pick", branch: "main", switches: false, run: { type: "cherry-pick", oids: [oid("x"), oid("y"), oid("z")] } });
  });

  it("uses the singular and names the switch for another branch", () => {
    expect(labels(graphDropActions(commits("x"), local("feature"), repo()))).toEqual(["Switch to feature and cherry-pick 1 commit"]);
  });

  it("disables picking the commit that is already the branch tip", () => {
    expect(graphDropActions(commits("a"), local("main"), repo())[0].disabled).toBe("This commit is already the tip of main");
    expect(graphDropActions(commits("a", "x"), local("main"), repo())[0].disabled).toBeUndefined();
  });

  it("offers nothing on a remote-tracking branch, on a commit, or without commits", () => {
    expect(graphDropActions(commits("x"), remote("origin/main"), repo())).toEqual([]);
    expect(graphDropActions(commits("x"), commit("y"), repo())).toEqual([]);
    expect(graphDropActions(commits("x", "y"), commit("y"), repo())).toEqual([]);
    expect(graphDropActions(commits(), local("main"), repo())).toEqual([]);
  });
});

describe("branch dropped on a commit", () => {
  it("offers reset and rebase for the current branch", () => {
    const actions = graphDropActions(local("main"), commit("x", "Fix login"), repo());
    expect(labels(actions)).toEqual(["Reset main to this commit…", "Rebase main onto this commit"]);
    expect(byId(actions, "reset")).toMatchObject({ branch: "main", switches: false, run: { type: "reset", oid: oid("x"), subject: "Fix login" } });
    expect(byId(actions, "rebase")).toMatchObject({ branch: "main", switches: false, run: { type: "rebase", onto: oid("x"), label: "xxxxxxxx" } });
  });

  it("names the switch for another local branch", () => {
    expect(labels(graphDropActions(local("feature"), commit("x"), repo()))).toEqual([
      "Switch to feature and reset it to this commit…",
      "Switch to feature and rebase it onto this commit",
    ]);
  });

  it("offers nothing on the branch's own tip or for a remote-tracking branch", () => {
    expect(graphDropActions(local("main"), commit("a"), repo())).toEqual([]);
    expect(graphDropActions(remote("origin/feature"), commit("x"), repo())).toEqual([]);
  });
});

describe("blocked states", () => {
  it("disables every Git action, but not compare, while an operation is in progress", () => {
    for (const [operation, name] of [["merge", "merge"], ["rebase", "rebase"], ["cherry-pick", "cherry-pick"], ["squash", "squash merge"], ["am", "patch application"]] as const) {
      const state = repo({ operation });
      const reason = `Finish or abort the ${name} in progress first`;
      const branchActions = graphDropActions(local("feature"), local("main"), state);
      expect(branchActions.filter(a => a.id !== "compare").map(a => a.disabled)).toEqual([reason, reason]);
      expect(byId(branchActions, "compare").disabled).toBeUndefined();
      expect(graphDropActions(commits("x"), local("main"), state)[0].disabled).toBe(reason);
      expect(graphDropActions(local("main"), commit("x"), state).map(a => a.disabled)).toEqual([reason, reason]);
      expect(graphDropActions(local("feature"), remote("origin/feature"), state)[0].disabled).toBe(reason);
    }
  });

  it("disables everything that needs a checked-out branch while HEAD is detached", () => {
    const state = repo({ head: null });
    const reason = "HEAD is detached. Check out a branch first";
    expect(graphDropActions(local("feature"), local("main"), state).map(a => a.disabled)).toEqual([reason, reason, undefined]);
    expect(graphDropActions(commits("x"), local("main"), state)[0]).toMatchObject({ disabled: reason, label: "Switch to main and cherry-pick 1 commit" });
    expect(graphDropActions(local("main"), commit("x"), state).map(a => a.disabled)).toEqual([reason, reason]);
    expect(graphDropActions(remote("origin/main"), local("main"), state)[0].disabled).toBe(reason);
  });

  it("disables only the actions that would switch to a branch checked out in another worktree", () => {
    const state = repo({ otherWorktreeBranches: ["feature"] });
    const onto = graphDropActions(local("feature"), local("main"), state);
    expect(byId(onto, "merge").disabled).toBeUndefined();
    expect(byId(onto, "rebase").disabled).toBe("feature is checked out in another worktree");
    const into = graphDropActions(local("main"), local("feature"), state);
    expect(byId(into, "merge").disabled).toBe("feature is checked out in another worktree");
    expect(byId(into, "rebase").disabled).toBeUndefined();
    expect(graphDropActions(commits("x"), local("feature"), state)[0].disabled).toBe("feature is checked out in another worktree");
    expect(graphDropActions(local("feature"), commit("x"), state).map(a => a.disabled)).toEqual(Array(2).fill("feature is checked out in another worktree"));
  });

  it("reports the operation in progress before any other reason and hides hints of disabled items", () => {
    const state = repo({
      operation: "rebase", head: null,
      local: [{ name: "main", oid: oid("a"), upstream: "origin/main", ahead: 0, behind: 1 }], remote: [{ name: "origin/main", oid: oid("f") }],
    });
    const forward = byId(graphDropActions(remote("origin/main"), local("main"), state), "fast-forward");
    expect(forward.disabled).toBe("Finish or abort the rebase in progress first");
    expect(forward.hint).toBeUndefined();
  });
});

describe("unknown or stale references", () => {
  it("offers nothing when a branch is no longer in the repository's refs", () => {
    expect(graphDropActions(local("gone"), local("main"), repo())).toEqual([]);
    expect(graphDropActions(local("feature"), local("gone"), repo())).toEqual([]);
    expect(graphDropActions(commits("x"), local("gone"), repo())).toEqual([]);
    expect(graphDropActions(local("gone"), commit("x"), repo())).toEqual([]);
  });

  it("keeps local and remote branches with the same short name apart", () => {
    const state = repo({ local: [{ name: "origin/main", oid: oid("b") }, { name: "main", oid: oid("a") }] });
    expect(labels(graphDropActions(local("origin/main"), remote("origin/main"), state))).toEqual([
      "Switch to origin/main and rebase it onto origin/main",
      "Compare origin/main with origin/main",
    ]);
  });
});

describe("drag label", () => {
  it("names the branch, the commit or the number of commits", () => {
    expect(dragItemLabel(local("feature/login"))).toBe("feature/login");
    expect(dragItemLabel(commits("a"), "Fix login")).toBe("aaaaaaaa Fix login");
    expect(dragItemLabel(commits("a"))).toBe("aaaaaaaa");
    expect(dragItemLabel(commits("a", "b"), "ignored")).toBe("2 commits");
  });
});
