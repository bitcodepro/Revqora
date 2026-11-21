import { describe, expect, it } from "vitest";
import { applyResolution, findLines, parseConflicts, resolveAll } from "./conflicts";
import { wordDiff } from "./worddiff";
import { initials, relativeTime } from "./format";
import { visibleUpdate } from "./update";
import { autoFetchRound, createAutoFetch, failedServer, fetchRound, REFS_CHANGED, transientFetchFailure, urlHost } from "./autofetch";
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

  it("backs off a repository the network keeps failing and logs it once, not every round", async () => {
    const logged: string[] = [];
    let calls = 0;
    const timeout = { message: "Git exceeded its 30 second time limit.", kind: "git-timeout", stderr: "", code: null, details: [] };
    const quietFetch = createAutoFetch({
      fetch: async () => { calls++; throw timeout; },
      refresh: async () => {},
      busy: () => false,
      log: (_root, error) => logged.push((error as { message: string }).message),
    });
    const rounds: string[] = [];
    for (let round = 0; round < 12; round++) rounds.push(await quietFetch("/repo"));
    // Tried in rounds 1, 2, 4, 8 and 12, then every 4th: never every round while the network is down.
    expect(rounds).toEqual(["transient", "transient", "skipped", "transient", "skipped", "skipped", "skipped", "transient", "skipped", "skipped", "skipped", "transient"]);
    expect(calls).toBe(5);
    expect(logged).toEqual(["Automatic fetch failed 3 times in a row. Last error: Git exceeded its 30 second time limit."]);
    // Other failures are logged once per message.
    const broken = createAutoFetch({
      fetch: async () => { throw { message: "fatal: bad config", kind: "error", stderr: "", code: 128, details: [] }; },
      refresh: async () => {},
      busy: () => false,
      log: (_root, error) => logged.push((error as { message: string }).message),
    });
    logged.length = 0;
    expect(await broken("/repo")).toBe("failed");
    expect(await broken("/repo")).toBe("failed");
    expect(logged).toEqual(["fatal: bad config"]);
  });

  it("skips a server that keeps failing for the rest of a round and still fetches the others", async () => {
    const down = (root: string) => ({ message: `unable to access 'https://git.example.invalid/team/${root.slice(1)}.git/': The requested URL returned error: 502`, kind: "server-unavailable", stderr: "", code: 128, details: [] });
    const attempts: string[] = [];
    const quietFetch = createAutoFetch({
      fetch: async root => { attempts.push(root); if (root.startsWith("/down")) throw down(root); return { refsChanged: false }; },
      refresh: async () => {},
      busy: () => false,
      log: () => {},
    });
    const roots = ["/down-1", "/down-2", "/down-3", "/down-4", "/up-1", "/up-2"];
    // First round: no server is known yet; each failure names it.
    await autoFetchRound(roots, quietFetch, () => true, () => true, 1);
    expect(attempts).toEqual(roots);
    expect(quietFetch.server("/down-4")).toBe("git.example.invalid");
    // Next round: two failures, then the rest of that server waits; the other server is fetched.
    attempts.length = 0;
    await autoFetchRound(roots, quietFetch, () => true, () => true, 1);
    expect(attempts).toEqual(["/down-1", "/down-2", "/up-1", "/up-2"]);
    // A server known from the open repository's remote is skipped before it is tried.
    const known = createAutoFetch({
      fetch: async root => { attempts.push(root); throw down(root); },
      refresh: async () => {},
      busy: () => false,
      log: () => {},
      serverOf: () => "git.example.invalid",
    });
    attempts.length = 0;
    await autoFetchRound(["/down-5", "/down-6", "/down-7"], known, () => true, () => true, 1);
    expect(attempts).toEqual(["/down-5", "/down-6"]);
    // Time limits name no server: two of them end the round.
    const offline = createAutoFetch({
      fetch: async root => { attempts.push(root); throw { message: "Git exceeded its 90 second time limit.", kind: "git-timeout", stderr: "", code: null, details: [] }; },
      refresh: async () => {},
      busy: () => false,
      log: () => {},
    });
    attempts.length = 0;
    await autoFetchRound(["/a", "/b", "/c"], offline, () => true, () => true, 1);
    expect(attempts).toEqual(["/a", "/b"]);
  });

  it("counts a mirror's failure for the mirror's server and keeps fetching the others of origin's server", async () => {
    const attempts: string[] = [];
    const mirror = (root: string) => ({ message: `unable to access 'https://mirror.example.invalid/${root.slice(1)}.git/': Could not resolve host: mirror.example.invalid`, kind: "error", stderr: "", code: 128, details: [] });
    const quietFetch = createAutoFetch({
      fetch: async root => { attempts.push(root); if (root.startsWith("/mirror")) throw mirror(root); return { refsChanged: false }; },
      refresh: async () => {},
      busy: () => false,
      log: () => {},
      // Every repository's origin is on the same server.
      serverOf: () => "git.example.invalid",
    });
    const roots = ["/mirror-1", "/mirror-2", "/repo-1", "/repo-2", "/repo-3"];
    await autoFetchRound(roots, quietFetch, () => true, () => true, 1);
    expect(attempts).toEqual(roots);
    expect(quietFetch.failedAt("/mirror-1")).toBe("mirror.example.invalid");
    expect(quietFetch.failedAt("/repo-1")).toBe("git.example.invalid");
  });

  it("blames no server for a failure without a host when the repository fetches from several", async () => {
    const attempts: string[] = [];
    const timeout = { message: "Git exceeded its 90 second time limit.", kind: "git-timeout", stderr: "", code: null, details: [] };
    const quietFetch = createAutoFetch({
      fetch: async root => { attempts.push(root); if (root.startsWith("/two-servers")) throw timeout; return { refsChanged: false }; },
      refresh: async () => {},
      busy: () => false,
      log: () => {},
      serverOf: () => "git.example.invalid",
      serversOf: root => root.startsWith("/two-servers") ? ["git.example.invalid", "mirror.example.invalid"] : ["git.example.invalid"],
    });
    const roots = ["/two-servers-1", "/two-servers-2", "/two-servers-3", "/repo-1", "/repo-2"];
    await autoFetchRound(roots, quietFetch, () => true, () => true, 1);
    expect(attempts).toEqual(roots);
    expect(quietFetch.failedAt("/two-servers-1")).toBe(false);
  });

  it("shows what a fetch brought although one remote failed", async () => {
    const refreshed: boolean[] = [];
    const failed: string[] = [];
    const partly = { message: "error: could not fetch mirror", kind: "error", stderr: "", code: 1, details: [REFS_CHANGED] };
    const quietFetch = createAutoFetch({
      fetch: async () => { throw partly; },
      refresh: async (_root, changed) => { refreshed.push(changed); },
      failed: (_root, e) => failed.push((e as { message: string }).message),
      busy: () => false,
      log: () => {},
    });
    expect(await quietFetch("/repo")).toBe("failed");
    expect(refreshed).toEqual([true]);
    expect(failed).toEqual([partly.message]);
    // Without moved refs nothing is read again.
    const quiet = createAutoFetch({ fetch: async () => { throw { ...partly, details: [] }; }, refresh: async (_root, changed) => { refreshed.push(changed); }, busy: () => false, log: () => {} });
    expect(await quiet("/other")).toBe("failed");
    expect(refreshed).toEqual([true]);
  });

  it("does not take a refused sign-in or permission for the network", async () => {
    const forbidden = { message: "fatal: unable to access 'https://git.example.invalid/team/api.git/': The requested URL returned error: 403", kind: "error", stderr: "", code: 128, details: [] };
    const unavailable = { ...forbidden, message: forbidden.message.replace("403", "503") };
    expect(transientFetchFailure(forbidden)).toBe(false);
    expect(transientFetchFailure({ ...forbidden, message: forbidden.message.replace("403", "404") })).toBe(false);
    expect(transientFetchFailure(unavailable)).toBe(true);
    const logged: string[] = [];
    const quietFetch = createAutoFetch({ fetch: async () => { throw forbidden; }, refresh: async () => {}, busy: () => false, log: (_root, error) => logged.push((error as { message: string }).message) });
    expect(await quietFetch("/repo")).toBe("failed");
    expect(logged).toEqual([forbidden.message]);
  });

  it("counts network failures in a row apart from other failures", async () => {
    const timeout = { message: "Git exceeded its 30 second time limit.", kind: "git-timeout", stderr: "", code: null, details: [] };
    const broken = { message: "fatal: bad config", kind: "error", stderr: "", code: 128, details: [] };
    const logged: string[] = [];
    const answers: unknown[] = [broken, timeout, timeout, broken, timeout, timeout, timeout];
    const quietFetch = createAutoFetch({
      fetch: async () => { throw answers.shift(); },
      refresh: async () => {},
      busy: () => false,
      log: (_root, error) => logged.push((error as { message: string }).message),
    });
    const results: string[] = [];
    // Skipped rounds (the backoff) are left out of the answers.
    while (answers.length) {
      const result = await quietFetch("/repo");
      if (result !== "skipped") results.push(result);
    }
    expect(results).toEqual(["failed", "transient", "transient", "failed", "transient", "transient", "transient"]);
    // Neither two network failures after another failure nor a row broken by one is three in a row.
    expect(logged).toEqual(["fatal: bad config", "Automatic fetch failed 3 times in a row. Last error: Git exceeded its 30 second time limit."]);
  });

  it("reads the server of remote URLs and fetch failures", () => {
    expect(urlHost("https://gitea.example.com/team/api.git")).toBe("gitea.example.com");
    expect(urlHost("ssh://git@Host.example:2222/team/api.git")).toBe("host.example");
    expect(urlHost("git@bitbucket.org:team/api.git")).toBe("bitbucket.org");
    expect(urlHost("C:\\repos\\api")).toBeNull();
    expect(urlHost("/srv/git/api.git")).toBeNull();
    expect(failedServer({ message: "Could not resolve host: gitea.example.com", kind: "error", stderr: "", code: 128, details: [] })).toBe("gitea.example.com");
    expect(failedServer({ message: "ssh: connect to host git.example.com port 22: Connection timed out", kind: "error", stderr: "", code: 128, details: [] })).toBe("git.example.com");
    expect(failedServer({ message: "Git exceeded its 90 second time limit.", kind: "git-timeout", stderr: "", code: null, details: [] })).toBeNull();
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
