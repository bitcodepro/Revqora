import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { assertAgentWorktreeProtection, assertAgentDraft } from "./agent-workspace-fixture.mjs";

import { openRepository, repositoryIsActive } from "./ui-readiness.mjs";

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

test("agent launch preflight rejects redirected input before any preview or launch", async () => {
  const expected={title:"Offline task",executable:"fixture-node.exe",args:["fixture.cjs"],prompt:"Fixture prompt"};
  const controls={"Task title":expected.title,"Agent provider":"custom","Agent executable":expected.executable,"Agent arguments":JSON.stringify(expected.args),"Agent prompt":expected.prompt};
  const dialog={getByRole:(_role,{name})=>({inputValue:async()=>controls[name]})};
  await assertAgentDraft(dialog,expected);
  controls["Task title"]=expected.executable;controls["Agent executable"]="";
  await assert.rejects(assertAgentDraft(dialog,expected),/Task title.*no launch was prepared/);
  controls["Task title"]=expected.title;
  await assert.rejects(assertAgentDraft(dialog,expected),/Agent executable.*no launch was prepared/);
});

for (const repository of ["stage16-agents", "stage12-accounts"]) test(`${repository}: restart waits for readiness, then sends one open and waits for exact identity without reconstructing records`, async () => {
 const calls=[];let release;const ready=new Promise(resolve=>release=resolve);const root=path.resolve("fixture",repository);
 const page={evaluate:async(fn,arg)=>{const prior=globalThis.window;globalThis.window={__TAURI_INTERNALS__:{invoke:async(command,args)=>calls.push([command,args])}};try{await fn(arg);}finally{globalThis.window=prior;}},waitForFunction:async(fn,arg)=>{assert.equal(fn,repositoryIsActive);calls.push(["identity",arg.expected]);},locator:selector=>selector.includes("data-app-startup")?{waitFor:async()=>{calls.push(["wait-ready"]);await ready;}}:{filter:filter=>({waitFor:async()=>calls.push([selector,filter])})}};
 const opening=openRepository(page,root);await Promise.resolve();assert.deepEqual(calls,[["wait-ready"]],"No event can be emitted before ready");release();await opening;
 assert.deepEqual(calls,[["wait-ready"],["plugin:event|emit",{event:"open-paths",payload:[root]}],["identity",root],[".topbar .repo-current > b",{hasText:repository}]]);
});

test("repository acknowledgement rejects a different directory with the same basename and handles native Windows paths", () => {
 const previous=globalThis.document;let actual="D:/other/stage16-agents";globalThis.document={querySelector:()=>({getAttribute:()=>actual})};
 try{assert.equal(repositoryIsActive({expected:"D:/fixture/stage16-agents",windows:true}),false);actual="\\\\?\\D:\\fixture\\stage16-agents";assert.equal(repositoryIsActive({expected:"d:/fixture/stage16-agents",windows:true}),true);actual="/fixture/Case";assert.equal(repositoryIsActive({expected:"/fixture/case",windows:false}),false);}finally{globalThis.document=previous;}
});
