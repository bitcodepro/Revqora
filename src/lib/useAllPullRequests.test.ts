import { describe, expect, it, vi } from "vitest";
import { authorOf } from "./prAuthors";
import type { ForgeInfo, PullRequest } from "./types";
import { mineOnly, type RepositoryRequests } from "./useAllPullRequests";

vi.mock("./api", () => ({ api: {}, errorMessage: String }));

const forge = { kind: "github", api: "https://api.github.com", project: "team/repo", accountLogin: "alice" } as ForgeInfo;
const pull = (number: number, id: string, login: string) => ({ number, authorId: id, authorLogin: login, author: login } as PullRequest);
const mine = pull(1, "1", "alice"), theirs = pull(2, "2", "bob");
const group = (change: Partial<RepositoryRequests>): RepositoryRequests => ({ forge, scope: "scope", author: authorOf(mine), items: [mine, theirs], ...change });

describe("My PR across repositories", () => {
  it("keeps only the configured author's pull requests", () => {
    expect(mineOnly({ "/repo": group({}) })["/repo"].items).toEqual([mine]);
  });

  it("still filters the rows loaded before a later page failed and keeps the error", () => {
    const filtered = mineOnly({ "/repo": group({ notice: "Page 2 could not be loaded." }) })["/repo"];
    expect(filtered.items).toEqual([mine]);
    expect(filtered.notice).toBe("Page 2 could not be loaded.");
  });

  it("shows nothing for a repository without My PR author, even after a page error", () => {
    const unset = mineOnly({ "/repo": group({ author: null }) })["/repo"];
    expect(unset.items).toEqual([]);
    expect(unset.notice).toBe("Set My PR author in this repository to include its pull requests.");
    const failed = mineOnly({ "/repo": group({ author: null, notice: "Page 2 could not be loaded." }) })["/repo"];
    expect(failed.items).toEqual([]);
    expect(failed.notice).toBe("Page 2 could not be loaded. Set My PR author in this repository to include its pull requests.");
  });

  it("leaves a repository that failed before its first page unchanged", () => {
    const before = { forge: null, scope: "", author: null, items: [], notice: "Sign in again." };
    expect(mineOnly({ "/repo": before })["/repo"]).toBe(before);
  });
});
