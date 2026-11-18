// Local stand-ins for the GitHub, GitLab, Bitbucket and Azure DevOps pull request APIs, for
// performance baselines and behaviour checks (docs/APP_PERFORMANCE.md, "Baseline harness").
// Each provider listens on its own loopback port; Revqora accounts may use plain HTTP there.
//
// Every repository serves the same PR numbers (1..pulls), so equal numbers in different
// repositories are always present. A repository's scenario sets how its list behaves:
//   ok            pages of 50 after `delayMs`
//   slow          every response waits `slowMs` longer
//   forbidden     403 (missing repository permission)
//   rate-limited  GitHub: 403 with x-ratelimit-remaining: 0; others: 429 with Retry-After
//   incomplete    the second page has rows without a source branch (incomplete metadata)
//   truncated     the second page is cut off in the middle of the JSON
import http from "node:http";

export const PROVIDERS = ["github", "gitlab", "bitbucket", "azure"];
const PAGE = 50;
const TOKEN = "perf-fixture-token";

/** Repository path on the provider for a fixture repository name (for remote URLs). */
export function remotePath(kind, name) {
  return kind === "azure" ? `/org/Perf/_git/${name}` : `/team/${name}.git`;
}

/** Account server for `forge_account_add` (Azure uses the organization URL). */
export const accountServer = (kind, url) => kind === "azure" ? `${url}/org` : url;
export const fixtureToken = TOKEN;

function pull(kind, repo, number) {
  const created = new Date(Date.UTC(2026, 0, 1) + number * 3_600_000).toISOString();
  const title = `${repo} request ${number}`;
  const sha = number.toString(16).padStart(40, "0");
  const author = number % 3 ? { id: 7, login: "perf-author" } : { id: 8, login: "perf-reviewer" };
  switch (kind) {
    case "github":
      return { number, title, user: author, head: { ref: `topic-${number}`, sha }, base: { ref: "main", sha }, state: "open", draft: false, created_at: created, updated_at: created, html_url: `https://example.invalid/${repo}/pull/${number}` };
    case "gitlab":
      return { iid: number, title, author: { id: author.id, username: author.login }, source_branch: `topic-${number}`, target_branch: "main", web_url: `https://example.invalid/${repo}/-/merge_requests/${number}`, draft: false, state: "opened", created_at: created, sha };
    case "bitbucket":
      return { id: number, title, author: { uuid: `{${author.id}}`, nickname: author.login, display_name: author.login }, source: { branch: { name: `topic-${number}` }, commit: { hash: sha } }, destination: { branch: { name: "main" } }, links: { html: { href: `https://example.invalid/${repo}/pull-requests/${number}` } }, draft: false, state: "OPEN", created_on: created, participants: [] };
    default:
      return { pullRequestId: number, title, createdBy: { id: `0000000${author.id}-0000-0000-0000-000000000000`, displayName: author.login, uniqueName: author.login }, sourceRefName: `refs/heads/topic-${number}`, targetRefName: "refs/heads/main", isDraft: false, status: "active", creationDate: created, lastMergeSourceCommit: { commitId: sha } };
  }
}

function listRoute(kind, pathname) {
  const patterns = {
    github: /^\/api\/v3\/repos\/team\/([^/]+)\/pulls$/,
    gitlab: /^\/api\/v4\/projects\/team%2F([^/]+)\/merge_requests$/,
    bitbucket: /^\/2\.0\/repositories\/team\/([^/]+)\/pullrequests$/,
    azure: /^\/org\/Perf\/_apis\/git\/repositories\/([^/]+)\/pullrequests$/,
  };
  return decodeURIComponent(pathname.match(patterns[kind])?.[1] ?? "") || null;
}

function profileRoute(kind, pathname) {
  return { github: "/api/v3/user", gitlab: "/api/v4/user", bitbucket: "/2.0/user", azure: "/org/_apis/connectionData" }[kind] === pathname;
}

function profile(kind) {
  if (kind === "azure") return { authenticatedUser: { id: "00000007-0000-0000-0000-000000000000", providerDisplayName: "perf-author", properties: { Account: { $value: "perf-author" } } } };
  if (kind === "bitbucket") return { uuid: "{7}", nickname: "perf-author", display_name: "perf-author", account_id: "7" };
  return { id: 7, login: "perf-author", username: "perf-author", name: "Perf Author" };
}

/** Page number and size from the provider's own paging parameters. */
function paging(kind, url) {
  const q = url.searchParams;
  if (kind === "azure") return { offset: Number(q.get("$skip") || 0), size: Number(q.get("$top") || PAGE) };
  const size = Number(q.get(kind === "bitbucket" ? "pagelen" : "per_page") || PAGE);
  return { offset: (Number(q.get("page") || 1) - 1) * size, size };
}

/**
 * Starts the four providers. `scenarios` maps a repository name to a scenario (default "ok").
 * Returns `{ urls, requests, setScenario, close }`; `requests` records each request with its
 * provider, path, status and server-side duration.
 */
export async function startForgeFixture({ pulls = 60, delayMs = 40, slowMs = 1200, scenarios = {} } = {}) {
  const requests = [];
  const current = { ...scenarios };
  const servers = {};
  const urls = {};
  for (const kind of PROVIDERS) {
    const server = http.createServer(async (req, res) => {
      const started = performance.now();
      const url = new URL(req.url, "http://fixture");
      const record = { kind, method: req.method, path: url.pathname, status: 0, ms: 0 };
      requests.push(record);
      const send = (status, value, headers = {}) => {
        record.status = status;
        record.ms = performance.now() - started;
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(typeof value === "string" ? value : JSON.stringify(value));
      };
      // GitLab personal tokens come in PRIVATE-TOKEN; Azure and Bitbucket may use Basic.
      const auth = req.headers.authorization ?? "";
      const basic = auth.startsWith("Basic ") ? Buffer.from(auth.slice(6), "base64").toString() : "";
      if (!auth.includes(TOKEN) && !basic.endsWith(`:${TOKEN}`) && req.headers["private-token"] !== TOKEN) return send(401, { message: "Token rejected" });
      if (profileRoute(kind, url.pathname)) return send(200, profile(kind));
      const repo = listRoute(kind, url.pathname);
      if (!repo || req.method !== "GET") return send(404, { message: `Not part of the fixture: ${req.method} ${url.pathname}` });
      const scenario = current[repo] ?? "ok";
      await new Promise(resolve => setTimeout(resolve, delayMs + (scenario === "slow" ? slowMs : 0)));
      if (scenario === "forbidden") return send(403, { message: "Resource not accessible by this token" });
      if (scenario === "rate-limited") {
        return kind === "github"
          ? send(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60) })
          : send(429, { message: "Too many requests" }, { "retry-after": "60" });
      }
      const { offset, size } = paging(kind, url);
      const rows = Array.from({ length: Math.max(0, Math.min(size, pulls - offset)) }, (_, i) => pull(kind, repo, pulls - offset - i));
      if (offset > 0 && scenario === "incomplete") rows.forEach(row => { delete row.head; delete row.source_branch; delete row.source; delete row.sourceRefName; });
      const more = offset + rows.length < pulls;
      const body = kind === "bitbucket" ? { values: rows, pagelen: size, ...(more ? { next: `${url.origin}${url.pathname}?page=${offset / size + 2}` } : {}) }
        : kind === "azure" ? { value: rows, count: rows.length }
        : rows;
      const text = JSON.stringify(body);
      return send(200, offset > 0 && scenario === "truncated" ? text.slice(0, Math.floor(text.length / 2)) : text);
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    servers[kind] = server;
    urls[kind] = `http://127.0.0.1:${server.address().port}`;
  }
  return {
    urls,
    requests,
    setScenario: (repo, scenario) => { current[repo] = scenario; },
    close: () => Promise.all(Object.values(servers).map(server => new Promise(resolve => server.close(resolve)))),
  };
}
