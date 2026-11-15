import { describe, expect, it } from "vitest";
import { jumpStep } from "./historyJump";

describe("history jump", () => {
  it("widens a branch scope that excludes the target once its history is fully loaded", () => {
    expect(jumpStep({ found: false, moreHistory: false, scoped: true })).toBe("widen-scope");
    expect(jumpStep({ found: false, moreHistory: true, scoped: true })).toBe("load-more");
    expect(jumpStep({ found: true, moreHistory: true, scoped: true })).toBe("scroll");
    expect(jumpStep({ found: false, moreHistory: false, scoped: false })).toBe("not-found");
  });
});
