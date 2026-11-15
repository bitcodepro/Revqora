import { describe, expect, it } from "vitest";
import { jumpStep, lastRowStep } from "./historyJump";

describe("history jump", () => {
  it("widens a branch scope that excludes the target once its history is fully loaded", () => {
    expect(jumpStep({ found: false, moreHistory: false, scoped: true })).toBe("widen-scope");
    expect(jumpStep({ found: false, moreHistory: true, scoped: true })).toBe("load-more");
    expect(jumpStep({ found: true, moreHistory: true, scoped: true })).toBe("scroll");
    expect(jumpStep({ found: false, moreHistory: false, scoped: false })).toBe("not-found");
  });
});

describe("End on a paged history", () => {
  it("selects the last row at once when the view already renders the fully loaded graph", () => {
    // The usual order: the store update re-renders History before the load reports back.
    expect(lastRowStep({ sameView: true, loadedKey: "graph-8", renderedKey: "graph-8" })).toBe("select");
    // Nothing more to load: the graph is the one the key press saw.
    expect(lastRowStep({ sameView: true, loadedKey: "graph-7", renderedKey: "graph-7" })).toBe("select");
  });
  it("waits for the render when the new graph is not shown yet", () => {
    expect(lastRowStep({ sameView: true, loadedKey: "graph-8", renderedKey: "graph-7" })).toBe("await-render");
    expect(lastRowStep({ sameView: true, loadedKey: "graph-8", renderedKey: null })).toBe("await-render");
  });
  it("does nothing when the scope or selection changed while loading, or the load failed", () => {
    expect(lastRowStep({ sameView: false, loadedKey: "graph-8", renderedKey: "graph-8" })).toBe("skip");
    expect(lastRowStep({ sameView: true, loadedKey: null, renderedKey: "graph-7" })).toBe("skip");
  });
});
