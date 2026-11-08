import { getVersion } from "@tauri-apps/api/app";
import { expect, it, vi } from "vitest";
import { appVersion } from "./appVersion";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn() }));

it("updates existing and new displays after retrying a failed version lookup", async () => {
  vi.mocked(getVersion).mockRejectedValueOnce(new Error("IPC unavailable")).mockResolvedValueOnce("0.1.42");
  const statusBar = vi.fn(), about = vi.fn();
  const unmountStatusBar = appVersion.subscribe((state) => statusBar(state.version));
  const { load } = appVersion.getState();
  await load();
  expect(statusBar).toHaveBeenLastCalledWith(null);

  const unmountAbout = appVersion.subscribe((state) => about(state.version));
  await Promise.all([load(), load()]);
  expect(getVersion).toHaveBeenCalledTimes(2);
  expect(statusBar).toHaveBeenLastCalledWith("0.1.42");
  expect(about).toHaveBeenLastCalledWith("0.1.42");
  expect(appVersion.getState().version).toBe("0.1.42");

  await load();
  expect(getVersion).toHaveBeenCalledTimes(2);
  unmountAbout();
  unmountStatusBar();
});
