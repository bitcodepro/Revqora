import { describe, expect, it } from "vitest";
import { mergeTargets } from "./remoteSync";
import { SHORTCUTS } from "./shortcuts";

describe("bulk fetch, pull and push", () => {
  it("merges selected branches per repository and keeps a whole repository whole", () => {
    expect(mergeTargets([
      { root: "/a", branches: ["refs/heads/x"] },
      { root: "/b", branches: ["refs/heads/y"] },
      { root: "/a", branches: ["refs/heads/z", "refs/heads/x"] },
      { root: "/b" },
      { root: "/c", branches: [] },
    ])).toEqual([
      { root: "/a", branches: ["refs/heads/x", "refs/heads/z"] },
      { root: "/b", branches: undefined },
    ]);
  });

  it("offers the global commands in Settings without default keys", () => {
    for (const id of ["fetch-all", "pull-all", "push-all", "fetch-current", "pull-current", "push-current"]) {
      const shortcut = SHORTCUTS.find(entry => entry.id === id);
      expect(shortcut, id).toBeDefined();
      expect(shortcut!.default, id).toBe("");
    }
  });
});
