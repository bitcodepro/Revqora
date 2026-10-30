import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("URL push fixture reports exact local ref changes while retaining local heads and staging", t => {
  const base = path.resolve(process.env.REVQORA_TEST_TMP || os.tmpdir());
  fs.mkdirSync(base, { recursive: true });
  const work = fs.mkdtempSync(path.join(base, "cleanup-url-push-"));
  const root = path.join(work, "reviewed"), server = path.join(work, "server.git");
  const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
  const refs = () => new Map(git(root, "for-each-ref", "--format=%(refname)%09%(objectname)").split(/\r?\n/).map(line => line.split("\t")));
  try {
    fs.mkdirSync(root); git(root, "init", "-qb", "main");
    for (const [k, v] of [["user.name", "Fixture"], ["user.email", "fixture@example.invalid"], ["commit.gpgsign", "false"], ["core.autocrlf", "false"], ["core.hooksPath", ".git/hooks"]]) git(root, "config", k, v);
    fs.writeFileSync(path.join(root, "file.txt"), "base\n"); git(root, "add", "."); git(root, "commit", "-qm", "Base");
    for (const name of ["bulk-clean-a", "bulk-clean-b"]) git(root, "branch", name);
    git(root, "clone", "--bare", ".", server); git(root, "remote", "add", "origin", server); git(root, "fetch", "-q", "origin");
    const next = git(root, "commit-tree", git(root, "rev-parse", "HEAD^{tree}"), "-p", "HEAD", "-m", "Server fixture update");
    const before = refs(), index = fs.readFileSync(path.join(root, ".git/index")), config = fs.readFileSync(path.join(root, ".git/config"));
    git(root, "push", "-q", server, `${next}:refs/heads/bulk-clean-b`);
    const after = refs();
    const changes = [...new Set([...before.keys(), ...after.keys()])].filter(ref => before.get(ref) !== after.get(ref)).map(ref => ({ ref, before: before.get(ref), after: after.get(ref) }));
    // Git versions may differ in URL-to-remote cache updates. Record observed
    // refs, not a guessed cause; the server-only UI fixture must avoid this push.
    t.diagnostic(JSON.stringify({ git: git(root, "--version"), urlPushLocalRefChanges: changes }));
    for (const change of changes) {
      assert.equal(change.ref, "refs/remotes/origin/bulk-clean-b");
      assert.equal(change.after, next);
    }
    for (const [ref, oid] of before) if (ref.startsWith("refs/heads/")) assert.equal(after.get(ref), oid);
    assert.equal(git(server, "rev-parse", "bulk-clean-a"), before.get("refs/heads/bulk-clean-a"));
    assert.equal(git(server, "rev-parse", "bulk-clean-b"), next);
    assert.ok(fs.readFileSync(path.join(root, ".git/index")).equals(index));
    assert.ok(fs.readFileSync(path.join(root, ".git/config")).equals(config));
  } finally { fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
});
