import { expect, it, vi } from "vitest";
const session = vi.hoisted(() => ({ openMany: vi.fn(() => new Promise<PromiseSettledResult<string | null>[]>(() => {})) }));
vi.mock("./settings", () => ({ useSettings: { getState: () => ({ openTabs: ["/one", "/two"], activeTab: "/two" }) } }));
vi.mock("./store", () => ({ useRepos: { getState: () => session } }));
import { restoreRepositorySession } from "./restoreRepositorySession";
it("registers the saved selection synchronously once, without waiting for Git or repeating StrictMode startup", () => {
  const first = restoreRepositorySession();
  expect(session.openMany).toHaveBeenCalledExactlyOnceWith(["/one", "/two"], "/two");
  expect(restoreRepositorySession()).toBe(first);
  expect(session.openMany).toHaveBeenCalledTimes(1);
});
