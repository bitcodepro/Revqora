import { describe, expect, it } from "vitest";
import { parseCloneInput, repoNameFromUrl } from "./cloneInput";

describe("clone clipboard input", () => {
  const bitbucket = "https://gorillatv@bitbucket.org/myrepos_webler/be-repos.git";
  it.each([bitbucket, `git clone ${bitbucket}`, `  git\tclone  '${bitbucket}'  `, `git clone "${bitbucket}"`, `"${bitbucket}"`])("preserves the HTTPS username in %s", input => {
    expect(parseCloneInput(input)).toEqual({ url: bitbucket, error: "" });
    expect(repoNameFromUrl(parseCloneInput(input).url)).toBe("be-repos");
  });
  it.each(["git@bitbucket.org:team/repo.git", "ssh://git@server/team/repo.git", "file:///D:/projects/repo.git"])("preserves literal Git source %s", source => {
    expect(parseCloneInput(`git clone ${source}`)).toEqual({ url: source, error: "" });
    expect(repoNameFromUrl(source)).toBe("repo");
  });
  it("preserves Windows paths and spaces without interpreting shell escaping", () => {
    const source = String.raw`D:\Git projects\it's a repo.git`;
    expect(parseCloneInput(source)).toEqual({ url: source, error: "" });
    expect(parseCloneInput(`git clone "${source}"`)).toEqual({ url: source, error: "" });
    expect(repoNameFromUrl(source)).toBe("it's a repo");
  });
  it.each(["git clone", `git clone ${bitbucket} destination`, `git clone --depth 1 ${bitbucket}`, `git clone ${bitbucket} && echo other`, `git clone '${bitbucket}`, `git clone ${bitbucket}\necho other`, "--bare"])("rejects ambiguous commands without silently ignoring arguments: %s", input => {
    expect(parseCloneInput(input).url).toBe("");
    expect(parseCloneInput(input).error).toContain("destination folder");
  });
  it("leaves an empty field neutral and removes only the trailing Git suffix", () => {
    expect(parseCloneInput("   ")).toEqual({ url: "", error: "" });
    expect(repoNameFromUrl("https://host/repository.git/")).toBe("repository");
    expect(repoNameFromUrl("https://host/repository.git.backup")).toBe("repository.git.backup");
  });
});
