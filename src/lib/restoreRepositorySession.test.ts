import { expect, it, vi } from "vitest";
const session = vi.hoisted(() => ({ openMany: vi.fn(() => new Promise<PromiseSettledResult<string | null>[]>(() => {})) }));
vi.mock("./settings", () => ({ useSettings: { getState: () => ({ openTabs: ["/one", "/two"], activeTab: "/two", openLibraryOnStartup: true }) } }));
vi.mock("./repositoryLibrary", async (original) => ({ ...await original<typeof import("./repositoryLibrary")>(), useLibrary: { getState: () => ({ knownRoots: ["/one", "/three"], activeWorkspaceId: null }) } }));
vi.mock("./store", () => ({ useRepos: { getState: () => session } }));
import { restoreRepositorySession, startupRepositoryRoots } from "./restoreRepositorySession";
it("registers the saved selection synchronously once, without waiting for Git or repeating StrictMode startup", () => {
  const first = restoreRepositorySession();
  expect(session.openMany).toHaveBeenCalledExactlyOnceWith(["/one", "/two", "/three"], "/two");
  expect(restoreRepositorySession()).toBe(first);
  expect(session.openMany).toHaveBeenCalledTimes(1);
});

it("includes every saved repository while retaining the order and identity of open tabs", () => {
  expect(startupRepositoryRoots(["C:/One", "/two"], ["c:\\one", "/grouped", "/ungrouped", "invalid", "/two"], true, null)).toEqual(["C:/One", "/two", "/grouped", "/ungrouped"]);
});
it("respects the previous-session option and a named workspace's repository set", () => {
  expect(startupRepositoryRoots(["/one"], ["/two"], false, null)).toEqual(["/one"]);
  expect(startupRepositoryRoots(["/one"], ["/two"], true, "workspace")).toEqual(["/one"]);
});
