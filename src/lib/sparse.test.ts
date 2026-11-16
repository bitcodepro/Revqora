import { describe, expect, it } from "vitest";
// @ts-expect-error The project has no Node typings; vitest runs this file in Node.
import { execFileSync } from "node:child_process";
// @ts-expect-error The project has no Node typings; vitest runs this file in Node.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
// @ts-expect-error The project has no Node typings; vitest runs this file in Node.
import { tmpdir } from "node:os";
// @ts-expect-error The project has no Node typings; vitest runs this file in Node.
import { join } from "node:path";
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

  it("keeps ancestors' own files and escapes pattern characters, as Git writes cone patterns", () => {
    expect(coneToPatterns(["src/app", "[abc]"])).toEqual(["/*", "!/*/", "/\\[abc]/", "/src/", "!/src/*/", "/src/app/"]);
    // A folder inside another selected folder adds nothing.
    expect(coneToPatterns(["src", "src/app"])).toEqual(["/*", "!/*/", "/src/"]);
    expect(coneToPatterns(["a/b/c"])).toEqual(["/*", "!/*/", "/a/", "!/a/*/", "/a/b/", "!/a/b/*/", "/a/b/c/"]);
    // Converting back returns the selected folders only, not their ancestors.
    expect(patternsToFolders(coneToPatterns(["src/app", "[abc]", "a/b/c"]))).toEqual({ folders: ["[abc]", "a/b/c", "src/app"], dropped: [] });
  });
});

describe("cone to non-cone conversion with real Git", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  const checkedOut = (root: string, files: string[]) => files.filter((f) => existsSync(join(root, f))).sort();

  it("checks out the same files after switching cone folders to the generated patterns", () => {
    const root = mkdtempSync(join(tmpdir(), "revqora-sparse-"));
    try {
      const files = ["top.txt", "src/top.txt", "src/app/x.txt", "src/other/y.txt", "[abc]/wanted.txt", "a/unwanted.txt", "b/deep/z.txt", "b/own.txt"];
      git(root, "init", "-q", "-b", "main");
      for (const file of files) {
        mkdirSync(join(root, file, ".."), { recursive: true });
        writeFileSync(join(root, file), file);
      }
      git(root, "add", ".");
      git(root, "-c", "user.name=Sparse test", "-c", "user.email=sparse@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "files");
      const folders = ["src/app", "[abc]", "b/deep"];
      execFileSync("git", ["-C", root, "sparse-checkout", "set", "--cone", "--skip-checks", "--stdin"], { input: folders.join("\n") + "\n" });
      const cone = checkedOut(root, files);
      execFileSync("git", ["-C", root, "sparse-checkout", "set", "--no-cone", "--stdin"], { input: coneToPatterns(folders).join("\n") + "\n" });
      expect(checkedOut(root, files)).toEqual(cone);
      expect(cone).toEqual(["[abc]/wanted.txt", "b/deep/z.txt", "b/own.txt", "src/app/x.txt", "src/top.txt", "top.txt"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
