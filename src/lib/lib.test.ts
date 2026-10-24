import { describe, expect, it } from "vitest";
import { applyResolution, findLines, parseConflicts, resolveAll } from "./conflicts";
import { wordDiff } from "./worddiff";
import { initials, relativeTime } from "./format";

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
    expect(initials("Ada Lovelace")).toBe("AL");
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
