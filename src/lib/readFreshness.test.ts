import { describe, expect, it } from "vitest";
import { changeTime, unreadParts } from "./readFreshness";

const ALL = { info: true, status: true, refs: true, layers: true, graph: true };

describe("unreadParts", () => {
  it("skips every part read after the change and keeps the rest", () => {
    expect(unreadParts({ info: 100, status: 100, refs: 100, layers: 100, graph: 100 }, ALL, 90)).toBeNull();
    expect(unreadParts({ info: 100, status: 100, refs: 80, layers: 100, graph: 100 }, ALL, 90)).toEqual({ ...ALL, info: false, status: false, layers: false, graph: false });
    // Only a read that started after the change counts: one in the same millisecond may
    // have started just before it.
    expect(unreadParts({ status: 91 }, { status: true }, 90)).toBeNull();
    expect(unreadParts({ status: 90 }, { status: true }, 90)).toEqual({ status: true });
    expect(unreadParts({ status: 89 }, { status: true }, 90)).toEqual({ status: true });
    expect(unreadParts(undefined, { status: true, background: true }, 90)).toEqual({ status: true, background: true });
  });

  it("reads again when the read started between two changes of one burst", () => {
    // Changes at 90 and 100 are reported together with the last one's time.
    expect(unreadParts({ status: 95, info: 95 }, { status: true, info: true }, 100)).toEqual({ status: true, info: true });
  });

  it("lets a Changes-only status cover a working-file event but not a full status", () => {
    expect(unreadParts({ changes: 100, layers: 100 }, { status: true, layers: true, changesDisplay: true, background: true }, 90)).toBeNull();
    expect(unreadParts({ changes: 100 }, { status: true }, 90)).toEqual({ status: true });
  });
});

describe("changeTime", () => {
  it("uses the operation's end when it belongs to this call, otherwise now", () => {
    expect(changeTime(150, 100, 200)).toBe(150);
    expect(changeTime(50, 100, 200)).toBe(200);
    expect(changeTime(undefined, 100, 200)).toBe(200);
    expect(changeTime(250, 100, 200)).toBe(200);
  });
});
