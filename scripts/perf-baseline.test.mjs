import test from "node:test";
import assert from "node:assert/strict";
import { compare, expectedRows, percentile, prOutcomeProblem, stageTotal, summarize } from "./perf-baseline.mjs";
import { PROVIDERS, fixtureToken, startForgeFixture } from "./perf-forge-fixture.mjs";

test("median and p95 use the nearest rank and skip missing values", () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([5, 1, 3, 2, 4], 95), 5);
  assert.equal(percentile([10, 20], 50), 10);
  assert.equal(percentile([null, undefined], 50), null);
  const summary = summarize([{ total: 10, git: 4 }, { total: 30, git: 6 }, { total: 20 }]);
  assert.deepEqual(summary, { runs: 3, total: { median: 20, p95: 30 }, git: { median: 4, p95: 6 } });
});

test("nested graph stages are counted once", () => {
  const stages = [["refResolution", 10], ["gitWalk", 80], ["localOnly", 70], ["walkStage", 82], ["build", 120], ["exactCount", 15]];
  assert.equal(stageTotal({ stages }), 135);
  assert.equal(stageTotal({ stages: [["wait", 4], ["other", 6]] }), 10);
});

test("a comparison lists every scenario measured in both runs", () => {
  const before = { label: "a", scenarios: { start: { total: { median: 100, p95: 120 } }, gone: { total: { median: 1, p95: 1 } } } };
  const after = { label: "b", scenarios: { start: { total: { median: 50, p95: 80 } } } };
  const text = compare(before, after);
  assert.match(text, /^a → b/);
  assert.match(text, /start\s+100 → 50\s+120 → 80\s+-50%/);
  assert.doesNotMatch(text, /gone/);
});

const routes = {
  github: repo => `/api/v3/repos/team/${repo}/pulls?state=open&per_page=50&page=`,
  gitlab: repo => `/api/v4/projects/team%2F${repo}/merge_requests?state=opened&per_page=50&page=`,
  bitbucket: repo => `/2.0/repositories/team/${repo}/pullrequests?pagelen=50&page=`,
  azure: repo => `/org/Perf/_apis/git/repositories/${repo}/pullrequests?$top=50&$skip=`,
};
const pageParam = (kind, page) => kind === "azure" ? (page - 1) * 50 : page;
const rowsOf = (kind, body) => kind === "bitbucket" ? body.values : kind === "azure" ? body.value : body;

test("fake providers page, fail and cut responses as the scenario says", async () => {
  const forge = await startForgeFixture({ pulls: 60, delayMs: 0, slowMs: 0, scenarios: { denied: "forbidden", limited: "rate-limited", partial: "incomplete", cut: "truncated" } });
  try {
    for (const kind of PROVIDERS) {
      const get = (repo, page, token = fixtureToken) => fetch(`${forge.urls[kind]}${routes[kind](repo)}${pageParam(kind, page)}`, { headers: { authorization: `Bearer ${token}` } });
      const first = await get("one", 1), second = await get("one", 2);
      assert.equal(first.status, 200, kind);
      assert.equal(rowsOf(kind, await first.json()).length, 50, kind);
      assert.equal(rowsOf(kind, await second.json()).length, 10, kind);
      // Equal PR numbers in different repositories.
      const other = rowsOf(kind, await (await get("two", 1)).json());
      assert.equal(other.length, 50, kind);
      assert.equal((await get("one", 1, "wrong")).status, 401, kind);
      const url = `${forge.urls[kind]}${routes[kind]("one")}${pageParam(kind, 1)}`;
      assert.equal((await fetch(url, { headers: { "private-token": fixtureToken } })).status, 200, kind);
      assert.equal((await fetch(url, { headers: { authorization: `Basic ${Buffer.from(`user:${fixtureToken}`).toString("base64")}` } })).status, 200, kind);
      assert.equal((await fetch(url, { headers: { authorization: `Basic ${Buffer.from("user:wrong").toString("base64")}` } })).status, 401, kind);
      assert.equal((await get("denied", 1)).status, 403, kind);
      const limited = await get("limited", 1);
      assert.equal(limited.status, kind === "github" ? 403 : 429, kind);
      assert.ok(kind === "github" ? limited.headers.get("x-ratelimit-remaining") === "0" : limited.headers.get("retry-after"), kind);
      const partial = rowsOf(kind, await (await get("partial", 2)).json());
      assert.ok(partial.every(row => !row.head && !row.source_branch && !row.source && !row.sourceRefName), kind);
      assert.equal(rowsOf(kind, await (await get("partial", 1)).json()).length, 50, kind);
      await assert.rejects((await get("cut", 2)).json(), SyntaxError, kind);
    }
    assert.ok(forge.requests.every(request => request.status > 0 && request.ms >= 0));
  } finally {
    await forge.close();
  }
});

test("a PR run with an error in a healthy repository or a list from a failing one is not a measurement", () => {
  assert.equal(prOutcomeProblem("ok", { rows: 60, ms: 120 }, 60), null);
  assert.equal(prOutcomeProblem("slow", { rows: 60, ms: 3600 }, 60), null);
  assert.equal(prOutcomeProblem("forbidden", { rows: 0, error: "Access denied." }, 60), null);
  assert.equal(prOutcomeProblem("truncated", { rows: 50, error: "invalid JSON" }, 60), null);
  assert.match(prOutcomeProblem("ok", { rows: 0, error: "API rate limit reached.", ms: 90 }, 60), /^failed: API rate limit/);
  assert.match(prOutcomeProblem("ok", { rows: 50, ms: 90 }, 60), /50 of 60/);
  assert.match(prOutcomeProblem("rate-limited", { rows: 60, ms: 90 }, 60), /instead of failing/);
  assert.match(prOutcomeProblem("forbidden", { rows: 10, error: "Access denied." }, 60), /10 rows before/);
  assert.equal(prOutcomeProblem("ok", undefined, 60), "no result");
});

test("the PR Center refresh expects every loaded row, including rows read before a page error", () => {
  const repos = [..."ok ok slow forbidden rate-limited incomplete truncated".split(" ")].map(scenario => ({ scenario }));
  assert.equal(expectedRows(repos, 60), 60 * 3 + 50 * 2);
});
