import { describe, expect, it } from "vitest";
import { connectionLines, errorFacts, errorLogLines, operationLines, pullRequestErrorLines } from "./diagnostics";
import type { ConnectionCheckReport, OperationLogDetail } from "./types";

const report: ConnectionCheckReport = {
  repository: "repo", remote: "origin", url: "https://bitbucket.org/team/repo.git", transport: "https",
  provider: "Bitbucket Cloud", project: "team/repo", credentialSource: "API account someone (Accounts)",
  items: [
    { id: "git-read", label: "Git read (HTTPS)", state: "ok", detail: "Git listed 3 branches on the server.", ms: 410 },
    { id: "profile", label: "Account profile", state: "limited", detail: "Bitbucket denied access to the profile.", cause: "permission", next: "Pull requests can still work.", code: "identity-unavailable", httpStatus: 403, requestId: "bb-req-42", ms: 120 },
    { id: "pull-requests", label: "Pull request list", state: "ok", detail: "Listed 1 open pull requests.", ms: 90 },
  ],
};

describe("diagnostics report lines", () => {
  it("shows each check's result, cause, next step and HTTP facts", () => {
    const text = connectionLines(report).join("\n");
    expect(text).toContain("Remote: origin · https://bitbucket.org/team/repo.git (https)");
    expect(text).toContain("Credentials: API account someone (Accounts)");
    expect(text).toContain("✓ Git read (HTTPS): Works · 410 ms");
    expect(text).toContain("! Account profile: Limited · HTTP 403 · code identity-unavailable · request ID bb-req-42 · 120 ms");
    expect(text).toContain("  Cause: Insufficient permissions");
    expect(text).toContain("  Next step: Pull requests can still work.");
  });

  it("keeps the failing stage's code, status and request ID", () => {
    expect(errorFacts({ kind: "forge-rate-limit", details: ["http_status=429", "request_id=abc:1", "retry_after=60", "other"] }))
      .toEqual(["Error code: forge-rate-limit", "HTTP status: 429", "Request ID: abc:1", "Retry after (s): 60"]);
    expect(errorFacts("plain")).toEqual([]);
    const lines = pullRequestErrorLines("List pull requests", "D:/work/repo", "Access denied.", ["HTTP status: 403"], "GitHub · team/repo");
    expect(lines).toEqual(["Operation: List pull requests", "Repository: repo", "Provider: GitHub · team/repo", "HTTP status: 403", "Message:", "Access denied."]);
    expect(errorLogLines({ id: 1, timestamp: 0, source: "PR Center", code: "auth", message: "Token rejected.\nhttp_status=401\nrequest_id=x1", count: 2 }))
      .toEqual(["Operation: PR Center", "Error code: auth", "Recorded: 1970-01-01T00:00:00.000Z (×2)", "Message:", "Token rejected.", "HTTP status: 401", "Request ID: x1"]);
  });

  it("includes Git errors and timings of an operation but never command output", () => {
    const detail: OperationLogDetail = {
      entry: { id: "1", repo: "D:/work/repo", repositoryKey: "k", command: "push", status: "failed", requestedAt: 0, startedAt: 5, finishedAt: 900,
        waitMs: 5, durationMs: 895, beforeHead: null, afterHead: null, outcome: null, errorKind: "auth", error: "Authentication failed", truncated: false, checkpoints: [] },
      steps: [{ sequence: 1, cwd: "D:/work/repo", args: ["push", "origin", "main"], startedAt: 5, durationMs: 880, exitCode: 128,
        stdout: "file content that must stay private", stderr: "fatal: Authentication failed", outputOmitted: false, truncated: false }],
    };
    const text = operationLines(detail).join("\n");
    expect(text).toContain("Timings: queue wait 5 ms · total 895 ms");
    expect(text).toContain("git push origin main · exit 128 · 880 ms");
    expect(text).toContain("  fatal: Authentication failed");
    expect(text).not.toContain("file content");
    expect(text).not.toContain("D:/work");
  });
});
