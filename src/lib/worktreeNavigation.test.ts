import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./store", () => ({ useRepos: { getState: () => ({ open }) } }));
vi.mock("./api", () => ({ errorMessage: (e: unknown) => String(e), isGitError: () => false }));
const { open } = vi.hoisted(() => ({ open: vi.fn() }));
import { openWorktree } from "./worktreeNavigation";
import { captureOverlay, closeOverlay, openOverlay, toast, useUi, type Overlay } from "./ui";

const root = "D:/repos/main";
function deferred() {
  let resolve!: () => void, reject!: (e: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function manager() {
  const overlay: Overlay = { kind: "worktrees", root };
  openOverlay(overlay);
  return { overlay, owner: captureOverlay("worktrees", root)! };
}

beforeEach(() => { open.mockReset(); closeOverlay(); });

describe("worktree opening owns only its originating navigation", () => {
  it("closes its unchanged manager after a successful open", async () => {
    const pending = deferred(), { overlay, owner } = manager();
    open.mockReturnValueOnce(pending.promise);
    const result = openWorktree("D:/repos/topic", owner);
    expect(useUi.getState().overlay).toBe(overlay);
    pending.resolve(); await result;
    expect(open).toHaveBeenCalledWith("D:/repos/topic");
    expect(useUi.getState().overlay).toBeNull();
  });

  it("does not dismiss a newer Branch Manager after Close during a delayed open", async () => {
    const pending = deferred(), { owner } = manager();
    open.mockReturnValueOnce(pending.promise);
    const result = openWorktree("D:/repos/topic", owner);
    closeOverlay(); const newer: Overlay = { kind: "branches", root }; openOverlay(newer);
    pending.resolve(); await result;
    expect(useUi.getState().overlay).toBe(newer);
  });

  it.each([false, true])("invalidates ownership when reopening the same overlay object (close first: %s)", async closeFirst => {
    const pending = deferred(), { overlay, owner } = manager();
    open.mockReturnValueOnce(pending.promise);
    const result = openWorktree("D:/repos/topic", owner);
    if (closeFirst) closeOverlay();
    openOverlay(overlay);
    pending.resolve(); await result;
    expect(useUi.getState().overlay).toBe(overlay);
  });

  it("does not let an older open close the manager while a newer open is pending", async () => {
    const a = deferred(), b = deferred(), { overlay, owner } = manager();
    open.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const first = openWorktree("D:/repos/first", owner), second = openWorktree("D:/repos/second", owner);
    a.resolve(); await first; expect(useUi.getState().overlay).toBe(overlay);
    b.resolve(); await second; expect(useUi.getState().overlay).toBeNull();
  });

  it("keeps newer navigation when requests finish out of order", async () => {
    const a = deferred(), b = deferred(), { owner } = manager();
    open.mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const first = openWorktree("D:/repos/first", owner), second = openWorktree("D:/repos/second", owner);
    b.resolve(); await second; expect(useUi.getState().overlay).toBeNull();
    const newer: Overlay = { kind: "branches", root }; openOverlay(newer);
    a.resolve(); await first; expect(useUi.getState().overlay).toBe(newer);
  });

  it("a toast action opens a tab without dismissing the currently displayed overlay", async () => {
    const { overlay } = manager(); open.mockResolvedValueOnce(undefined);
    await openWorktree("D:/repos/from-toast");
    expect(useUi.getState().overlay).toBe(overlay);
  });

  it("cannot acquire a newer manager with a ticket captured before worktree creation", async () => {
    const { owner } = manager(); const { overlay: newer } = manager();
    open.mockResolvedValueOnce(undefined);
    await openWorktree("D:/repos/created", owner);
    expect(useUi.getState().overlay).toBe(newer);
  });

  it("reports failed opening without dismissing its manager", async () => {
    const { overlay, owner } = manager(), error = new Error("Unable to open fixture");
    const report = vi.spyOn(toast, "error").mockImplementation(() => {});
    try {
      open.mockRejectedValueOnce(error); await openWorktree("D:/repos/missing", owner);
      expect(useUi.getState().overlay).toBe(overlay);
      expect(report).toHaveBeenCalledWith(error, "Could not open worktree");
    } finally { report.mockRestore(); }
  });
});
