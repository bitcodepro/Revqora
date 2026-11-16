import { describe, expect, it } from "vitest";
import { branchError, buildCloneOptions, defaultCloneOptionsForm, parseDepth } from "./cloneOptions";

describe("clone options", () => {
  it("defaults to a full clone with submodules", () => {
    expect(buildCloneOptions(defaultCloneOptionsForm())).toEqual({
      options: { branch: null, depth: null, noSingleBranch: false, filter: "none", recurseSubmodules: true, shallowSubmodules: false, sparse: false, sparseFolders: [] },
      error: "",
    });
  });

  it("rejects option injection and invalid branch names", () => {
    expect(branchError("--upload-pack=evil")).not.toBe("");
    expect(branchError("-b")).not.toBe("");
    expect(branchError("a..b")).not.toBe("");
    expect(branchError("has space")).not.toBe("");
    expect(branchError("x.lock")).not.toBe("");
    expect(branchError("feature/ok-1")).toBe("");
    expect(buildCloneOptions({ ...defaultCloneOptionsForm(), branch: "-x" }).options).toBeNull();
  });

  it("parses depth strictly", () => {
    expect(parseDepth("")).toEqual({ depth: null, error: "" });
    expect(parseDepth(" 3 ")).toEqual({ depth: 3, error: "" });
    for (const bad of ["0", "-1", "1.5", "1e3", "abc", "99999999999"]) expect(parseDepth(bad).error).not.toBe("");
  });

  it("only sends shallow-only flags with a depth", () => {
    const form = { ...defaultCloneOptionsForm(), shallowSubmodules: true };
    expect(buildCloneOptions(form).options).toMatchObject({ noSingleBranch: false, shallowSubmodules: false });
    expect(buildCloneOptions({ ...form, depth: "1", branch: " dev " }).options).toMatchObject({ branch: "dev", depth: 1, noSingleBranch: true, shallowSubmodules: true });
    expect(buildCloneOptions({ ...form, depth: "1", recurseSubmodules: false }).options).toMatchObject({ shallowSubmodules: false });
  });

  it("never passes through an unknown filter", () => {
    expect(buildCloneOptions({ ...defaultCloneOptionsForm(), filter: "sparse:oid=x" as never }).options?.filter).toBe("none");
    expect(buildCloneOptions({ ...defaultCloneOptionsForm(), filter: "tree:0" }).options?.filter).toBe("tree:0");
  });
  it("builds sparse clone folders", () => {
    const form = { ...defaultCloneOptionsForm(), sparse: true, sparseFolders: ["src", "", " docs/ ", "src"].join("\n") };
    expect(buildCloneOptions(form).options).toMatchObject({ sparse: true, sparseFolders: ["src", "docs"] });
    expect(buildCloneOptions({ ...form, sparseFolders: "../x" }).error).not.toBe("");
    expect(buildCloneOptions({ ...form, sparse: false }).options).toMatchObject({ sparse: false, sparseFolders: [] });
  });
});
