import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ValidationReport } from "./types";
const mocks = vi.hoisted(() => ({ report: vi.fn(), refresh: vi.fn(), status: vi.fn(), start: vi.fn() }));
vi.mock("./api", () => ({ api: { validationReport: mocks.report, status: mocks.status, validationStart: mocks.start } }));
vi.mock("./store", () => ({ useRepos: { getState: () => ({ refresh: mocks.refresh }) } }));
function deferred<T>() { let resolve!: (v: T) => void; let reject!: (e: unknown) => void; const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; }); return { promise, resolve, reject }; }
const report = (id: string, phase: ValidationReport["phase"]): ValidationReport => ({ id, repositoryRoot: "repo", command: id, phase, stdout: "", stderr: "", truncated: false, exitCode: phase === "passed" ? 0 : null, elapsedMs: 1, beforeState: "state", afterState: phase === "passed" ? "state" : null, error: null });
let validation: typeof import("./validation");
beforeEach(async () => { vi.useFakeTimers(); vi.resetModules(); vi.resetAllMocks(); mocks.refresh.mockResolvedValue(undefined); validation = await import("./validation"); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("validation polling lifecycle", () => {
  it("polls a second confirmed run while the previous terminal repository refresh is still pending", async () => {
    const sidebar = deferred<void>(); mocks.refresh.mockReturnValueOnce(sidebar.promise);
    mocks.report.mockResolvedValueOnce(report("first", "passed")).mockResolvedValueOnce(report("second", "running")).mockResolvedValueOnce(report("second", "passed"));
    const first = validation.refreshValidation("repo"); await vi.advanceTimersByTimeAsync(0);
    expect(mocks.refresh).toHaveBeenCalledOnce();
    try {
      // Same await boundaries as Run: status -> explicit confirmation -> start -> publish -> poll.
      mocks.status.mockResolvedValue({ stateToken: "state" }); mocks.start.mockResolvedValue(report("second", "queued"));
      await mocks.status("repo"); const confirmed = await Promise.resolve(true); expect(confirmed).toBe(true);
      validation.useValidation.getState().set("repo", await mocks.start("repo", "second", "state", 300));
      await validation.refreshValidation("repo");
      expect(mocks.report).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(300);
      expect(validation.useValidation.getState().reports.repo?.phase).toBe("passed");
      expect(vi.getTimerCount()).toBe(0);
    } finally { sidebar.resolve(); await first; }
  });
  it("discards an old in-flight response and schedules a poll for a newly published job", async () => {
    const oldResponse = deferred<ValidationReport>();
    mocks.report.mockReturnValueOnce(oldResponse.promise).mockResolvedValueOnce(report("new", "passed"));
    validation.useValidation.getState().set("repo", report("old", "running"));
    const first = validation.refreshValidation("repo");
    validation.useValidation.getState().set("repo", report("new", "queued"));
    await validation.refreshValidation("repo"); // suppressed while the old status request is in flight
    oldResponse.resolve(report("old", "passed")); await first;
    expect(validation.useValidation.getState().reports.repo?.id).toBe("new");
    await vi.advanceTimersByTimeAsync(300);
    expect(validation.useValidation.getState().reports.repo).toMatchObject({ id: "new", phase: "passed" });
  });
  it("keeps retrying a running check after a transient status failure", async () => {
    validation.useValidation.getState().set("repo", report("new", "queued"));
    mocks.report.mockRejectedValueOnce(new Error("temporary IPC failure")).mockResolvedValueOnce(report("new", "passed"));
    await expect(validation.refreshValidation("repo")).rejects.toThrow("temporary IPC failure");
    await vi.advanceTimersByTimeAsync(300);
    expect(validation.useValidation.getState().reports.repo?.phase).toBe("passed");
  });
  it("deduplicates status queries without holding the guard during sidebar updates", async () => {
    const response = deferred<ValidationReport>(); mocks.report.mockReturnValueOnce(response.promise);
    const first = validation.refreshValidation("repo"); await validation.refreshValidation("repo");
    expect(mocks.report).toHaveBeenCalledOnce(); response.resolve(report("done", "passed")); await first;
  });
  it("a failed old sidebar refresh cannot clear the guard of a newer status request", async () => {
    const sidebar = deferred<void>(); const next = deferred<ValidationReport>();
    mocks.refresh.mockReturnValueOnce(sidebar.promise);
    mocks.report.mockResolvedValueOnce(report("old", "passed")).mockReturnValueOnce(next.promise).mockResolvedValueOnce(report("new", "passed"));
    const first = validation.refreshValidation("repo").catch(() => {}); await vi.advanceTimersByTimeAsync(0);
    validation.useValidation.getState().set("repo", report("new", "queued"));
    const second = validation.refreshValidation("repo");
    sidebar.reject(new Error("sidebar failed")); await first;
    await validation.refreshValidation("repo");
    expect(mocks.report).toHaveBeenCalledTimes(2);
    next.resolve(report("new", "running")); await second; await vi.advanceTimersByTimeAsync(300);
    expect(validation.useValidation.getState().reports.repo).toMatchObject({ id: "new", phase: "passed" });
  });
});
