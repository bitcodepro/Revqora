import { describe, expect, it } from "vitest";
import { detailsNeedExpanding } from "./toastDetails";

describe("toast details", () => {
  it("long or multi-line details get Details / Copy; short ones stay inline", () => {
    expect(detailsNeedExpanding(undefined)).toBe(false);
    expect(detailsNeedExpanding("Push rejected.")).toBe(false);
    expect(detailsNeedExpanding("a\nb\nc")).toBe(false);
    expect(detailsNeedExpanding("a\nb\nc\nd")).toBe(true);
    expect(detailsNeedExpanding("x".repeat(241))).toBe(true);
  });
});
