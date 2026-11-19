import { describe, expect, it } from "vitest";
import { applyResolution, findLines, parseConflicts, resolveAll } from "./conflicts";
import { wordDiff } from "./worddiff";
import { initials, relativeTime } from "./format";
import { visibleUpdate } from "./update";
import { createAutoFetch, fetchRound } from "./autofetch";
import type { UpdateInfo } from "./types";

const SAMPLE = `top
<<<<<<< ours
mine 1
mine 2
||||||| base
orig
=======
theirs 1
>>>>>>> theirs
middle
<<<<<<< ours
a
=======
b
>>>>>>> theirs
end
`;

describe("conflict parsing", () => {
  it("finds blocks with base sections", () => {
    const blocks = parseConflicts(SAMPLE);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].ours).toEqual(["mine 1", "mine 2"]);
    expect(blocks[0].base).toEqual(["orig"]);
    expect(blocks[0].theirs).toEqual(["theirs 1"]);
    expect(blocks[0].oursLabel).toBe("ours");
    expect(blocks[1].base).toBeNull();
    expect(blocks[1].startLine).toBe(10);
  });

  it("applies resolutions", () => {
    const blocks = parseConflicts(SAMPLE);
    const t = applyResolution(SAMPLE, blocks[1], "both");
    expect(t).toContain("middle\na\nb\nend\n");
    expect(parseConflicts(t)).toHaveLength(1);
    expect(resolveAll(SAMPLE, "theirs")).toBe("top\ntheirs 1\nmiddle\nb\nend\n");
    expect(resolveAll(SAMPLE, "ours")).toBe("top\nmine 1\nmine 2\nmiddle\na\nend\n");
  });

  it("keeps CRLF line endings", () => {
    const crlf = SAMPLE.replace(/\n/g, "\r\n");
    const out = resolveAll(crlf, "ours");
    expect(out).toBe("top\r\nmine 1\r\nmine 2\r\nmiddle\r\na\r\nend\r\n");
  });

  it("ignores unterminated markers", () => {
    expect(parseConflicts("<<<<<<< x\nfoo\n=======\nbar\n")).toHaveLength(0);
  });

  it("locates lines", () => {
    expect(findLines(["a", "b", "c", "b", "c"], ["b", "c"], 2)).toBe(3);
    expect(findLines(["a"], ["z"])).toBe(-1);
  });
});

describe("word diff", () => {
  it("marks only changed words", () => {
    const d = wordDiff("const value = 1;", "const value = 2;");
    expect(d.old.filter((s) => s.changed).map((s) => s.text)).toEqual(["1"]);
    expect(d.new.filter((s) => s.changed).map((s) => s.text)).toEqual(["2"]);
  });
});

describe("format", () => {
  it("initials and relative time", () => {
    expect(initials("Alex Rivera")).toBe("AR");
    expect(initials("linus")).toBe("LI");
    expect(relativeTime(1000, 1010)).toBe("just now");
    expect(relativeTime(1000, 1000 + 3 * 3600)).toBe("3 hours ago");
  });
});

describe("syntax highlighting", () => {
  it("splits tokens per line and keeps the text intact", async () => {
    const { languageFor, highlightLines } = await import("./languages");
    const lang = await languageFor("a.ts");
    expect(lang).not.toBeNull();
    const lines = ["const a = 1; /* multi", "line */ let b = 'x';", ""];
    const out = highlightLines(lang!.language, lines);
    expect(out).toHaveLength(3);
    out.forEach((toks, i) => expect(toks.map((t) => t.text).join("")).toBe(lines[i]));
    expect(out[0].some((t) => t.cls.includes("keyword"))).toBe(true);
    expect(out[1].some((t) => t.cls.includes("comment"))).toBe(true);
  });
});

describe("visibleUpdate", () => {
  const info = (latest: string, available: boolean): UpdateInfo => ({
    current: "0.1.0",
    latest,
    available,
    notes: "",
    publishedAt: null,
    htmlUrl: "",
    asset: null,
    canInstall: false,
    reason: null,
  });
  it("shows newer versions unless skipped", () => {
    expect(visibleUpdate(info("0.2.0", true), null)?.latest).toBe("0.2.0");
    expect(visibleUpdate(info("0.2.0", true), "0.2.0")).toBeNull();
    expect(visibleUpdate(info("0.3.0", true), "0.2.0")?.latest).toBe("0.3.0");
    expect(visibleUpdate(info("0.1.0", false), null)).toBeNull();
    expect(visibleUpdate(null, null)).toBeNull();
  });
});

describe("background fetch", () => {
  it("never runs twice at once for a repository and stops after an auth failure", async () => {
    let release: () => void = () => {};
    let calls = 0;
    const quietFetch = createAutoFetch({
      fetch: () => {
        calls++;
        return new Promise<void>((r) => (release = r));
      },
      refresh: async () => {},
      busy: () => false,
    });
    const first = quietFetch("/repo");
    await quietFetch("/repo"); // a slow request is still outstanding: skipped
    expect(calls).toBe(1);
    release();
    await first;
    const failing = createAutoFetch({
      fetch: async () => {
        calls++;
        throw { message: "Authentication failed", kind: "auth", stderr: "", code: 128, details: [] };
      },
      refresh: async () => {},
      busy: () => false,
    });
    calls = 0;
    await failing("/repo");
    await failing("/repo"); // missing or expired credentials: no more attempts
    expect(calls).toBe(1);
  });

  it("fetches a library of 40 repositories four at a time and stops when the round ends", async () => {
    let running = 0, peak = 0;
    const fetched: string[] = [];
    const roots = Array.from({ length: 40 }, (_, i) => `/repo-${i}`);
    await fetchRound(roots, async root => {
      peak = Math.max(peak, ++running);
      await new Promise(resolve => setTimeout(resolve, 2));
      running--;
      fetched.push(root);
    }, () => true, 4);
    expect(peak).toBe(4);
    expect(fetched.sort()).toEqual([...roots].sort());
    let started = 0;
    await fetchRound(roots, async () => { started++; }, () => started < 3, 4);
    expect(started).toBeLessThan(10);
  });

  it("treats a busy repository as a skipped round, not a failure", async () => {
    let calls = 0, refreshed = 0;
    const failed: unknown[] = [];
    const quietFetch = createAutoFetch({
      fetch: async () => {
        calls++;
        if (calls === 1) throw { message: "Another operation is running", kind: "repository-busy", stderr: "", code: null, details: [] };
      },
      refresh: async () => { refreshed++; },
      busy: () => false,
      failed: (_root, e) => failed.push(e),
    });
    await quietFetch("/repo");
    expect(failed).toEqual([]);
    expect(refreshed).toBe(0);
    await quietFetch("/repo"); // the next interval tries again
    expect(calls).toBe(2);
    expect(refreshed).toBe(1);
  });

  it("tells the refresh whether the fetch changed any ref", async () => {
    const answers: unknown[] = [{ output: "", refsChanged: false }, { output: "", refsChanged: true }, "older answer"];
    const changed: boolean[] = [];
    const quietFetch = createAutoFetch({
      fetch: async () => answers.shift(),
      refresh: async (_root, refs) => { changed.push(refs); },
      busy: () => false,
    });
    for (let i = 0; i < 3; i++) await quietFetch("/repo");
    // Only an explicit "nothing changed" skips reading; anything else reads as before.
    expect(changed).toEqual([false, true, true]);
  });
});
