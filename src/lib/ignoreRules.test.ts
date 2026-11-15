import { describe, expect, it } from "vitest";
import { ignoreChoices, previewTail } from "./ignoreRules";

describe("ignore choices", () => {
  it("offers the file, its extension and the nearest folders", () => {
    expect(ignoreChoices("src/build/out/app.min.js").map((c) => [c.kind, c.path])).toEqual([
      ["file", "src/build/out/app.min.js"], ["extension", "src/build/out/app.min.js"],
      ["folder", "src/build/out"], ["folder", "src/build"], ["folder", "src"],
    ]);
  });
  it("skips extensions for dotfiles and names without one, and folders at the root", () => {
    expect(ignoreChoices(".env").map((c) => c.kind)).toEqual(["file"]);
    expect(ignoreChoices("Makefile").map((c) => c.kind)).toEqual(["file"]);
    expect(ignoreChoices("logs/").map((c) => [c.kind, c.path])).toEqual([["file", "logs"]]);
  });
});

describe("ignore preview", () => {
  it("shows the end of the file and the added rule, with any line endings", () => {
    expect(previewTail("a\r\nb\r\n", "a\r\nb\r\n/x\r\n")).toEqual({ kept: ["a", "b"], added: ["/x"] });
    expect(previewTail("", "/x\n")).toEqual({ kept: [], added: ["/x"] });
    expect(previewTail("1\n2\n3\n4\n5\n6\n7\n8", "1\n2\n3\n4\n5\n6\n7\n8\n/x\n", 3)).toEqual({ kept: ["6", "7", "8"], added: ["/x"] });
  });
});
