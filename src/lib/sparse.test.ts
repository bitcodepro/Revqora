import { describe, expect, it } from "vitest";
import { changedAmong, conePreview, coneToPatterns, directoriesOf, inCone, normalizeFolder, parseFolderList, patternsToFolders } from "./sparse";

describe("sparse helpers", () => {
  it("normalizes and validates folders", () => {
    expect(normalizeFolder(" src\\app/ ").folder).toBe("src/app");
    expect(normalizeFolder("/docs").folder).toBe("docs");
    for (const bad of ["", "/", ".", "a/../b", ".git", "a//b"]) expect(normalizeFolder(bad).folder).toBeNull();
  });

  it("parses a folder list and drops blanks and duplicates", () => {
    expect(parseFolderList("src\n\n docs/ \nsrc\r\n")).toEqual({ folders: ["src", "docs"], error: "" });
    expect(parseFolderList("ok\n../x").error).not.toBe("");
  });

  it("lists directories from a tree listing", () => {
    expect(directoriesOf(["a.txt", "src/app/x.ts", "src/y.ts", "docs/r.md"])).toEqual(["docs", "src", "src/app"]);
  });

  it("matches cone mode semantics", () => {
    const folders = ["src/app"];
    expect(inCone("README.md", folders)).toBe(true);
    expect(inCone("src/app/deep/x.ts", folders)).toBe(true);
    expect(inCone("src/y.ts", folders)).toBe(true); // file directly in an ancestor
    expect(inCone("src/lib/z.ts", folders)).toBe(false);
    expect(inCone("srcx/app/a.ts", folders)).toBe(false);
    expect(inCone("docs/r.md", [])).toBe(false);
  });

  it("previews files leaving and arriving", () => {
    const paths = ["a.txt", "lib/x.ts", "docs/r.md"];
    expect(conePreview(paths, { enabled: false, cone: true, folders: [] }, ["lib"])).toEqual({ leaving: ["docs/r.md"], arriving: 0 });
    expect(conePreview(paths, { enabled: true, cone: true, folders: ["lib"] }, ["docs"])).toEqual({ leaving: ["lib/x.ts"], arriving: 1 });
    expect(conePreview(paths, { enabled: true, cone: false, folders: [] }, ["lib"])).toBeNull();
    expect(changedAmong(["lib/x.ts", "docs/r.md"], ["lib/x.ts", "a.txt"])).toEqual(["lib/x.ts"]);
  });

  it("converts between cone folders and patterns", () => {
    expect(coneToPatterns(["lib"])).toEqual(["/*", "!/*/", "/lib/"]);
    expect(patternsToFolders(["/*", "!/*/", "/lib/", "docs/", "*.md", "/one"])).toEqual({ folders: ["lib", "docs"], dropped: ["*.md", "/one"] });
  });
});
