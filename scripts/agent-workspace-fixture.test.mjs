import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { assertAgentWorktreeProtection, openAgentRepository } from "./agent-workspace-fixture.mjs";

test("agent worktree assertions preserve Git quoting and identify the exact locked task", t => {
  const base = path.resolve(process.env.REVQORA_TEST_TMP || os.tmpdir());
  fs.mkdirSync(base, { recursive: true });
  const work = fs.mkdtempSync(path.join(base, "agent-porcelain-"));
  const root = path.join(work, "source"), target = path.join(work, "agent copy — Україна"), other = path.join(work, "other copy");
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  const task = { id: "a".repeat(32), branch: "agent/fixture", path: target };
  const reason = `Agent task ${task.id} — unlock in Worktree Manager after review`;
  try {
    fs.mkdirSync(root); git("init", "-qb", "main");
    for (const [key, value] of [["user.name", "Fixture"], ["user.email", "fixture@example.invalid"], ["commit.gpgsign", "false"], ["core.hooksPath", ".git/hooks"]]) git("config", key, value);
    fs.writeFileSync(path.join(root, "file.txt"), "base\n"); git("add", "."); git("commit", "-qm", "Base");
    const head = git("rev-parse", "HEAD");
    git("worktree", "add", "-b", task.branch, target);
    git("worktree", "add", "-b", "other", other);
    git("worktree", "lock", "--reason", reason, target);
    for (const quote of ["true", "false"]) {
      git("config", "core.quotepath", quote);
      const raw = git("worktree", "list", "--porcelain");
      if (quote === "true") assert.ok(!raw.includes("locked Agent task"), "Fixture must reproduce the previous false rejection");
      assert.equal(assertAgentWorktreeProtection(git, task, head).get("locked"), reason);
    }
    t.diagnostic(JSON.stringify({ git: git("--version"), reproducedQuotedLock: true }));
    git("worktree", "unlock", target);
    const special = reason + ' "quoted" \\folder\nsecond line';
    git("worktree", "lock", "--reason", special, target);
    assert.equal(assertAgentWorktreeProtection(git, task, head).get("locked"), special);
    assert.throws(() => assertAgentWorktreeProtection(git, task, "0".repeat(40)), /wrong HEAD/);
    assert.throws(() => assertAgentWorktreeProtection(git, { ...task, branch: "other" }, head), /wrong branch/);
    git("worktree", "unlock", target);
    git("worktree", "lock", "--reason", reason, other);
    assert.throws(() => assertAgentWorktreeProtection(git, task, head), /not locked for task/);
    git("worktree", "lock", "--reason", reason.replace(task.id, "b".repeat(32)), target);
    assert.throws(() => assertAgentWorktreeProtection(git, task, head), /not locked for task/);
  } finally {
    const resolved = fs.realpathSync.native(work), parent = fs.realpathSync.native(base);
    if (!resolved.startsWith(parent + path.sep)) throw Error("Unowned worktree fixture cleanup target");
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("history restart opens only its repository, without reconstructing persisted tasks", async () => {
 const calls=[]; const page={ evaluate:async(fn,arg)=>{ const prior=globalThis.window;globalThis.window={__TAURI_INTERNALS__:{invoke:async(...args)=>calls.push(args)}};try{await fn(arg);}finally{globalThis.window=prior;}},locator:selector=>({filter:filter=>({waitFor:async()=>calls.push([selector,filter])})}) };
 await openAgentRepository(page,path.resolve("fixture","stage16-agents"));
 assert.deepEqual(calls,[["plugin:event|emit",{event:"open-paths",payload:[path.resolve("fixture","stage16-agents")]}],[".topbar .repo-current > b",{hasText:"stage16-agents"}]]);
});
