import { afterEach, expect, it, vi } from "vitest";
import { onPrRefresh, refreshRepositoryView } from "./prRefresh";

const state = vi.hoisted(() => ({
  tabs: { "/active": { view: "pulls" } },
  refresh: vi.fn(async (_root: string) => {}),
}));
vi.mock("./store", () => ({ useRepos: { getState: () => state } }));
afterEach(() => vi.unstubAllGlobals());

it("waits for the active PR Center and leaves other repositories alone", async () => {
  vi.stubGlobal("window", new EventTarget());
  let finish!: () => void;
  const active = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const inactive = vi.fn();
  const stop = onPrRefresh("/active", active);
  onPrRefresh("/other", inactive);
  let done = false;
  const result = refreshRepositoryView("/active").then(() => { done = true; });
  expect(state.refresh).toHaveBeenCalledWith("/active");
  expect(active).toHaveBeenCalledOnce();
  expect(inactive).not.toHaveBeenCalled();
  await Promise.resolve();
  expect(done).toBe(false);
  finish();
  await result;
  stop();
  await refreshRepositoryView("/active");
  expect(active).toHaveBeenCalledOnce();
});
