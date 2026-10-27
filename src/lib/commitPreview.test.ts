import { describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({ api: { commitDetails: vi.fn(), revDiff: vi.fn() } }));
import { PreviewCache, detailsKey, diffKey, loadDetails, peekDetails } from "./commitPreview";
import { api } from "./api";
import type { CommitDetails, DiffOptions } from "./types";

describe("commit preview memory cache", () => {
  it("coalesces concurrent loads and serves revisits without Git", async () => {
    const c = new PreviewCache<string>(); let finish!: (s: string) => void;
    const load = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const a = c.load("A", load); const b = c.load("A", load);
    await Promise.resolve(); finish("immutable");
    expect(await a).toBe("immutable"); expect(await b).toBe("immutable");
    expect(await c.load("A", load)).toBe("immutable"); expect(load).toHaveBeenCalledTimes(1);
  });
  it("evicts least recently used entries and obeys its byte budget", async () => {
    const c = new PreviewCache<string>(2, 1000);
    await c.load("A", async () => "A"); await c.load("B", async () => "B");
    c.peek("A"); await c.load("C", async () => "C");
    expect(c.peek("B")).toBeUndefined(); expect(c.peek("A")).toBe("A");
    const small = new PreviewCache<string>(10, 24, 24);
    await small.load("A", async () => "12345"); await small.load("B", async () => "12345");
    expect(small.peek("A")).toBeUndefined(); expect(small.peek("B")).toBe("12345");
  });
  it("does not retain oversized responses or failures", async () => {
    const c = new PreviewCache<string>(3, 100, 20);
    const load = vi.fn(async () => "x".repeat(100));
    await c.load("big", load); await c.load("big", load); expect(load).toHaveBeenCalledTimes(2);
    await expect(c.load("error", async () => { throw new Error("retry"); })).rejects.toThrow("retry");
    expect(await c.load("error", async () => "fixed")).toBe("fixed");
  });
  it("invalidates changed repositories and cannot resurrect an older in-flight result", async () => {
    const c = new PreviewCache<string>(); let finish!: (value: string) => void;
    const old = c.load("repo A", () => new Promise<string>((resolve) => { finish = resolve; }));
    await Promise.resolve();
    await c.load("repo B", async () => "other repo");
    c.invalidate((key) => key === "repo A");
    expect(await c.load("repo A", async () => "fresh")).toBe("fresh");
    finish("obsolete"); await old;
    expect(c.peek("repo A")).toBe("fresh"); expect(c.peek("repo B")).toBe("other repo");
  });
  it("separates repositories, remote-ref snapshots, paths and diff options", () => {
    expect(detailsKey("repo A", "oid", "remote A")).not.toBe(detailsKey("repo B", "oid", "remote A"));
    expect(detailsKey("repo A", "oid", "remote A")).not.toBe(detailsKey("repo A", "oid", "remote B"));
    const opts = { context: 3 } as DiffOptions;
    const key = diffKey("repo", "base", "oid", "file", opts);
    expect(key).not.toBe(diffKey("repo", null, "oid", "file", opts));
    expect(key).not.toBe(diffKey("repo", "base", "oid", "other", opts));
    expect(key).not.toBe(diffKey("repo", "base", "oid", "file", { ...opts, context: 8 }));
  });
  it("never caches mutable refs or abbreviated object names", async () => {
    vi.mocked(api.commitDetails).mockResolvedValue({ oid: "a".repeat(40) } as CommitDetails);
    for (const oid of ["HEAD", "main", "abcdef0"]) {
      const key = detailsKey("repo", oid, "refs");
      await loadDetails(key, "repo", oid); await loadDetails(key, "repo", oid);
      expect(peekDetails(key, oid)).toBeUndefined();
    }
    expect(api.commitDetails).toHaveBeenCalledTimes(6);
  });
});
