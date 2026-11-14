import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { readErrorLog, recordError } from "./errorLog";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

it("keeps unavailable saved folders out of the application error log", () => {
  vi.stubGlobal("window", {});
  vi.mocked(invoke).mockClear();
  recordError("refs_snapshot", { kind: "repository-folder-unavailable", message: "Repository folder is unavailable" }, "missing-repo");
  expect(invoke).not.toHaveBeenCalled();
});

it("records a status failure once and waits for it before opening the log", async () => {
  vi.stubGlobal("window", {});
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const backend = vi.mocked(invoke);
  backend.mockResolvedValue([]).mockImplementationOnce(() => pending);
  const error = {
    kind: "status-file-io",
    message: "Open file for status locked.txt",
    stderr: "Private command output",
    details: ["os_error=32", "secret arguments"],
  };
  recordError("status", error, "test-repo");
  recordError("Notification", error);
  const entries = readErrorLog();
  expect(backend).toHaveBeenCalledExactlyOnceWith("error_log_record", {
    source: "status",
    code: "status-file-io",
    message: "Open file for status locked.txt\nos_error=32\nRepository: test-repo",
  });
  finish();
  await expect(entries).resolves.toEqual([]);
  expect(backend).toHaveBeenLastCalledWith("error_log_list");
});
