import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { timedExecFileSync as execFileSync } from "./ci-timing.mjs";
import { openRepository } from "./ui-readiness.mjs";

async function renameAndCherryPick({ page, root, repository, git, request, rejected, tool, waitPhase, approval, approve, decline }) {
  const oldPath = "старый файл.bin", newPath = "новый файл.bin";
  const bytes = Buffer.from([0, 12, 255, 0, 40]);
  fs.writeFileSync(path.join(root, oldPath), bytes);
  git("add", "--", oldPath);
  git("commit", "-qm", "Add binary fixture");
  fs.renameSync(path.join(root, oldPath), path.join(root, newPath));
  for (const paths of [[newPath], [newPath, oldPath]]) {
    git("add", "-A");
    const status = await tool("repository_status", { repository });
    const rename = status.files.items.find(file => file.path === newPath);
    assert.equal(rename.index, "R");
    assert.equal(rename.origPath, oldPath);
    const diff = await tool("file_diff", { repository, path: newPath, side: "staged" });
    assert.equal(diff.oldPath, oldPath);
    assert.equal(diff.similarity, 100);
    assert.equal(diff.isNew || diff.isDeleted || diff.empty, false);
    const unstage = await request("unstage", { paths });
    const review = approval("Unstage files");
    const details = await review.locator(".code-list").textContent();
    assert.deepEqual(details.split("\n"), [newPath, oldPath]);
    await approve(review);
    await waitPhase(unstage.id, "succeeded");
    assert.equal(git("diff", "--cached", "--name-status"), "");
    assert.deepEqual(fs.readFileSync(path.join(root, newPath)), bytes);
    assert.equal(fs.existsSync(path.join(root, oldPath)), false);
  }
  git("add", "-A");
  git("commit", "-qm", "Rename binary fixture");
  const committed = await tool("file_diff", { repository, path: newPath, side: "commit", oid: git("rev-parse", "HEAD") });
  assert.equal(committed.oldPath, oldPath);

  const file = "conflict.txt";
  const put = value => fs.writeFileSync(path.join(root, file), value);
  git("switch", "-qc", "fixture/source");
  put("incoming version\n");
  git("add", file);
  git("commit", "-qm", "Add incoming version");
  const incoming = git("rev-parse", "HEAD");
  git("switch", "-q", "main");
  put("our version\n");
  git("add", file);
  git("commit", "-qm", "Add our version");
  const original = git("rev-parse", "HEAD");
  const pick = async () => {
    const action = await request("cherry_pick", { target: incoming });
    await approve(approval("Cherry-pick commit"));
    const paused = await waitPhase(action.id, "waiting_for_resolution");
    assert.deepEqual(paused.conflicts, [file]);
    return action;
  };
  const first = await pick();
  const status = await tool("repository_status", { repository });
  assert.equal(status.operation, "cherry-pick");
  assert.equal(status.conflictCount, 1);
  for (const side of ["staged", "unstaged"]) {
    const diff = await tool("file_diff", { repository, path: file, side });
    assert.equal(diff.kind, "conflict");
    assert.equal(diff.empty, false);
    assert.equal(diff.code, "AA");
    assert.equal(diff.base, null);
    assert.equal(diff.ours.text, "our version\n");
    assert.equal(diff.theirs.text, "incoming version\n");
    assert.equal(diff.ours.oid, git("rev-parse", `:2:${file}`));
    assert.equal(diff.theirs.oid, git("rev-parse", `:3:${file}`));
  }
  await rejected("cherry_pick_continue", undefined, "unresolved_conflicts");
  const declined = await request("cherry_pick_abort");
  await decline(approval("Abort cherry-pick"));
  assert.equal((await waitPhase(declined.id, "cancelled")).reason, "user_declined");
  await waitPhase(first.id, "waiting_for_resolution");
  await page.locator(".op-banner").getByRole("button", { name: "Abort", exact: true }).click();
  await page.getByRole("dialog", { name: "Abort cherry-pick?", exact: true }).getByRole("button", { name: "Abort cherry-pick", exact: true }).click();
  assert.equal((await waitPhase(first.id, "cancelled")).reason, "cherry_pick_aborted");
  assert.equal(git("rev-parse", "HEAD"), original);

  const second = await pick();
  const abort = await request("cherry_pick_abort");
  await approve(approval("Abort cherry-pick"));
  assert.equal((await waitPhase(abort.id, "succeeded")).result.aborted, true);
  assert.equal((await waitPhase(second.id, "cancelled")).reason, "cherry_pick_aborted");
  assert.equal(git("rev-parse", "HEAD"), original);

  const third = await pick();
  put("resolved version\n");
  git("add", file);
  const dismissed = await request("cherry_pick_continue");
  await approval("Continue cherry-pick").waitFor();
  await page.keyboard.press("Escape");
  assert.equal((await waitPhase(dismissed.id, "cancelled")).reason, "dialog_dismissed");
  assert.equal(git("rev-parse", "HEAD"), original);
  const proceed = await request("cherry_pick_continue");
  await approve(approval("Continue cherry-pick"));
  await waitPhase(proceed.id, "succeeded");
  const result = await waitPhase(third.id, "succeeded");
  assert.equal(result.result.sha, git("rev-parse", "HEAD"));
  assert.equal(git("show", `HEAD:${file}`), "resolved version");
  assert.equal((await tool("repository_status", { repository })).operation, "none");
  await rejected("cherry_pick_abort", undefined, "no_cherry_pick");
}

async function branchActions({ page, work, tool, rawTool, waitPhase, original }) {
  const root = path.join(work, "mcp-branch-fixture");
  fs.mkdirSync(root);
  const gitRaw = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  const git = (...args) => gitRaw(...args).trimEnd();
  git("init", "-qb", "main");
  git("config", "user.name", "MCP Fixture");
  git("config", "user.email", "mcp@example.invalid");
  git("config", "commit.gpgsign", "false");
  const file = path.join(root, "fixture.txt");
  fs.writeFileSync(file, "First revision\n");
  git("add", "fixture.txt");
  await openRepository(page, root);
  await page.locator(".topbar .repo-current > span").filter({hasText:"main"}).waitFor();
  const {active: repository} = await tool("list_repositories");
  assert(repository && path.relative(root, repository) === "");
  const request = (action, args = {}) => tool("request_action", { repository, action, ...args });
  const rejected = async (action, target, code) => {
    const response = await rawTool("request_action", { repository, action, target });
    assert.equal(response.isError, true);
    assert.equal(response.structuredContent.code, code);
    assert.equal(await page.getByRole("heading", {name:/^MCP request/}).count(), 0);
  };
  const approval = title => page.getByRole("dialog", {name:`MCP request · ${title}`, exact:true});
  const approve = dialog => dialog.getByRole("button", {name:"Approve in Revqora",exact:true}).click();
  const decline = dialog => dialog.getByRole("button", {name:"Decline",exact:true}).click();
  await rejected("create_branch", "feature/too-early", "initial_commit_required");
  for (const [proposed, approved] of [
    ["#TEST-1: Initial commit", "#TEST-1: Initial commit"],
    ["Proposed message", "#TEST-2: Approved message\n\nKeep the body.  \n# Literal detail\n\n"],
  ]) {
    const action = await request("commit", {message:proposed});
    const dialog = approval("Commit staged changes");
    const message = dialog.getByRole("textbox", {name:"Commit message",exact:true});
    assert.equal(await message.inputValue(), proposed);
    if (proposed !== approved) await message.fill(approved);
    await approve(dialog);
    const result = await waitPhase(action.id, "succeeded");
    assert.equal(result.result.sha, git("rev-parse", "HEAD"));
    const object = gitRaw("cat-file", "commit", "HEAD");
    assert.equal(object.slice(object.indexOf("\n\n") + 2), approved);
    if (proposed === approved) {
      fs.writeFileSync(file, "Second revision\n");
      git("add", "fixture.txt");
    }
  }

  await rejected("create_branch", "main", "branch_exists");
  const proposed = await request("create_branch", {target:"feature/proposed"});
  const create = approval("Create branch");
  const name = create.getByRole("textbox", {name:"Branch name",exact:true});
  assert.equal(await name.inputValue(), "feature/proposed");
  await name.fill("main");
  await create.getByRole("alert").waitFor();
  assert.equal(await create.getByRole("button", {name:"Approve in Revqora",exact:true}).isDisabled(), true);
  await name.fill("feature/approved");
  await approve(create);
  const created = await waitPhase(proposed.id, "succeeded");
  const tip = git("rev-parse", "HEAD");
  assert.deepEqual(created.result, {branch:"feature/approved",sha:tip});
  assert.equal(git("branch", "--list", "feature/proposed"), "");
  const cancelled = await request("create_branch", {target:"feature/cancelled"});
  await decline(create);
  await waitPhase(cancelled.id, "cancelled");
  assert.equal(git("branch", "--list", "feature/cancelled"), "");
  const stale = await request("create_branch", {target:"feature/stale"});
  await create.waitFor();
  fs.writeFileSync(file, "Externally staged after review\n");
  git("add", "fixture.txt");
  await approve(create);
  const failed = await waitPhase(stale.id, "failed");
  assert.equal(failed.errorCode, "stale_state");
  assert.equal(git("branch", "--list", "feature/stale"), "");
  git("restore", "--source=HEAD", "--staged", "--worktree", "--", "fixture.txt");

  const switchTo = async (from, to) => {
    const action = await request("checkout", {target:to});
    await approve(approval("Switch branch"));
    const result = await waitPhase(action.id, "succeeded");
    assert.deepEqual(result.result, {previousBranch:from,currentBranch:to,conflicts:[]});
    assert.equal(git("branch", "--show-current"), to);
  };
  await switchTo("main", "feature/approved");
  await rejected("delete_branch", "feature/approved", "branch_checked_out");
  await switchTo("feature/approved", "main");

  const deleteReview = page.getByRole("dialog", {name:"Delete branch feature/approved?",exact:true});
  const reviewDeletion = async () => {
    const action = await request("delete_branch", {target:"feature/approved"});
    await approve(approval("Review branch deletion"));
    await deleteReview.waitFor();
    return action;
  };
  const cancelledDeletion = await reviewDeletion();
  await deleteReview.getByRole("button", {name:"Cancel",exact:true}).click();
  await waitPhase(cancelledDeletion.id, "cancelled");
  assert.equal(git("rev-parse", "feature/approved"), tip);
  const deletion = await reviewDeletion();
  await deleteReview.getByRole("button", {name:"Delete local branch",exact:true}).click();
  const deleted = await waitPhase(deletion.id, "succeeded");
  assert.deepEqual(deleted.result, {branch:"feature/approved",sha:tip});
  assert.equal(git("branch", "--list", "feature/approved"), "");
  await renameAndCherryPick({ page, root, repository, git, request, rejected, tool, waitPhase, approval, approve, decline });
  await openRepository(page, original);
}

async function approvalModes({ page, root, work, tool, waitPhase, selectApproval }) {
  const request = (action, options = {}) => tool("request_action", { repository: root, action, ...options });
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trimEnd();
  const noDialog = async () => assert.equal(await page.getByRole("heading", { name: /^MCP request/ }).count(), 0);
  const automatic = async (action, options) => {
    const requested = await request(action, options);
    const result = await waitPhase(requested.id, "succeeded");
    assert.equal(result.approval, "automatic");
    await noDialog();
    return result;
  };

  await selectApproval("full", "ask");
  await automatic("create_branch", { target: "mcp-auto-delete" });
  const removed = await automatic("delete_branch", { target: "mcp-auto-delete" });
  assert.equal(removed.result.branch, "mcp-auto-delete");
  assert(removed.result.checkpoint);
  assert.equal(git("branch", "--list", "mcp-auto-delete"), "");

  await selectApproval("delete_only", "full");
  await automatic("create_branch", { target: "mcp-reviewed-delete" });
  const deletion = page.getByRole("dialog", { name: "MCP request · Review branch deletion", exact: true });
  const declined = await request("delete_branch", { target: "mcp-reviewed-delete" });
  await deletion.getByRole("button", { name: "Decline", exact: true }).click();
  assert.equal((await waitPhase(declined.id, "cancelled")).approval, "manual");
  assert(git("branch", "--list", "mcp-reviewed-delete"));
  const approved = await request("delete_branch", { target: "mcp-reviewed-delete" });
  await deletion.getByRole("button", { name: "Approve in Revqora", exact: true }).click();
  assert.equal((await waitPhase(approved.id, "succeeded")).approval, "manual");
  assert.equal(git("branch", "--list", "mcp-reviewed-delete"), "");

  const origin = path.join(work, "mcp-approval-origin.git");
  execFileSync("git", ["init", "--bare", "-q", origin], { windowsHide: true });
  git("remote", "add", "mcp-approval-origin", origin);
  try {
    git("config", "remote.mcp-approval-origin.prune", "true");
    git("update-ref", "refs/remotes/mcp-approval-origin/stale", "HEAD");
    await automatic("fetch");
    assert(git("for-each-ref", "refs/remotes/mcp-approval-origin/stale"));
    const prune = await request("fetch", { prune: true });
    const dialog = page.getByRole("dialog", { name: "MCP request · Fetch from all remotes", exact: true });
    await dialog.getByRole("button", { name: "Approve in Revqora", exact: true }).click();
    assert.equal((await waitPhase(prune.id, "succeeded")).approval, "manual");
    assert.equal(git("for-each-ref", "refs/remotes/mcp-approval-origin/stale"), "");
  } finally {
    git("remote", "remove", "mcp-approval-origin");
  }
  return approved.id;
}

async function diffStageAndStash({ page, original, work, tool, rawTool, waitPhase }) {
  const root = path.join(work, "mcp-diff-stage-stash");
  fs.mkdirSync(root);
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trimEnd();
  const put = (file, text) => fs.writeFileSync(path.join(root, file), text);
  git("init", "-qb", "main");
  git("config", "--local", "core.autocrlf", "false");
  git("config", "user.name", "MCP Fixture");
  git("config", "user.email", "mcp@example.invalid");
  git("config", "commit.gpgsign", "false");
  put("a.txt", "base a\n"); put("b.txt", "base b\n");
  git("add", "-A"); git("commit", "-qm", "Base");
  const base = git("rev-parse", "HEAD");
  await openRepository(page, root);
  await page.locator(".topbar .repo-current > span").filter({ hasText: "main" }).waitFor();
  const { active: repository } = await tool("list_repositories");
  assert(repository && path.relative(root, repository) === "");
  const request = (action, args = {}) => tool("request_action", { repository, action, ...args });
  const approve = title => page.getByRole("dialog", { name: `MCP request · ${title}`, exact: true }).getByRole("button", { name: "Approve in Revqora", exact: true }).click();

  const lines = Array.from({ length: 720 }, (_, i) => `line ${i}`);
  lines[212] = "x".repeat(599) + "🙂" + "rest".repeat(5000);
  put("large.txt", lines.join("\n") + "\n");
  const diff = { repository, path: "large.txt", side: "unstaged" };
  const first = await tool("file_diff", { ...diff, limit: 500 });
  assert.equal(first.nextOffset, 500);
  const stable = await tool("file_diff", { ...diff, limit: 500 });
  assert.equal(stable.diffVersion, first.diffVersion);
  const second = await tool("file_diff", { ...diff, offset: first.nextOffset, diffVersion: first.diffVersion });
  assert.equal(second.hunks[0].lines[0].text, "line 500");
  let piece = first.hunks.flatMap(hunk => hunk.lines).find(line => line.lineIndex === 212), text = piece.text;
  while (piece.nextTextOffset !== null) {
    const continuation = await tool("file_diff", { ...diff, offset: 212, lineOffset: piece.nextTextOffset, diffVersion: first.diffVersion });
    piece = continuation.hunks[0].lines[0]; text += piece.text;
  }
  assert.equal(text, lines[212]);
  lines[0] = "edit at the beginning";
  put("large.txt", lines.join("\n") + "\n");
  const changed = await rawTool("file_diff", { ...diff, offset: first.nextOffset, diffVersion: first.diffVersion });
  assert.equal(changed.structuredContent.code, "diff_changed");
  assert.equal((await tool("file_diff", diff)).totalLines, first.totalLines);
  fs.unlinkSync(path.join(root, "large.txt"));

  put("a.txt", "stage this version\n"); put("b.txt", "first unrelated edit\n");
  const selected = await request("stage", { paths: ["a.txt"] });
  await waitPhase(selected.id, "awaiting_confirmation");
  const busy = await rawTool("request_action", { repository, action: "stage", paths: ["b.txt"] });
  assert.equal(busy.structuredContent.code, "review_pending");
  assert.equal(busy.structuredContent.activeActionId, selected.id);
  put("b.txt", "second unrelated edit\n");
  await approve("Stage files");
  await waitPhase(selected.id, "succeeded");
  assert.equal(git("diff", "--cached", "--name-only"), "a.txt");
  const stale = await request("stage", { paths: ["b.txt"] });
  await waitPhase(stale.id, "awaiting_confirmation");
  put("b.txt", "changed selected file\n");
  await approve("Stage files");
  assert.equal((await waitPhase(stale.id, "failed")).errorCode, "stale_state");
  assert.equal(git("diff", "--cached", "--name-only"), "a.txt");
  git("reset", "--hard", "HEAD");

  git("config", "stash.index", "true");
  put("a.txt", "staged a\n"); put("b.txt", "staged b\n"); git("add", "-A");
  put("b.txt", "working b\n"); put("new.txt", "untracked\n");
  git("stash", "push", "-u", "-m", "Mixed staging fixture");
  const { items } = await tool("list_stashes", { repository });
  assert.equal(items.length, 1);
  const args = { stashIndex: items[0].index, target: items[0].oid };
  const apply = await request("stash_apply", args);
  await approve("Apply stash");
  const restored = await waitPhase(apply.id, "succeeded");
  assert.equal(restored.result.indexRestored, true);
  assert.equal(restored.result.stashKept, true);
  assert.equal(git("show", ":b.txt"), "staged b");
  assert.equal(fs.readFileSync(path.join(root, "b.txt"), "utf8"), "working b\n");
  assert.equal(fs.readFileSync(path.join(root, "new.txt"), "utf8"), "untracked\n");
  git("reset", "--hard", "HEAD"); fs.unlinkSync(path.join(root, "new.txt"));

  put("a.txt", "staged a\n"); git("add", "a.txt"); git("commit", "-qm", "Destination has same A");
  const pop = await request("stash_pop", args);
  await approve("Pop stash");
  const partial = await waitPhase(pop.id, "partial");
  assert.equal(partial.result.status, "index_not_restored");
  assert.equal(partial.result.stashKept, true);
  assert.deepEqual(partial.result.staging.find(row => row.path === "b.txt"), { path: "b.txt", currentlyStaged: false, matchesSavedIndex: false });
  assert.equal(git("show", ":b.txt"), "base b");
  assert.equal(fs.readFileSync(path.join(root, "b.txt"), "utf8"), "working b\n");
  assert.equal((await tool("list_stashes", { repository })).items[0].oid, args.target);
  git("reset", "--hard", base); fs.unlinkSync(path.join(root, "new.txt"));

  const worktreeOnly = await request("stash_pop", { ...args, restoreIndex: false });
  await approve("Pop stash");
  const completed = await waitPhase(worktreeOnly.id, "succeeded");
  assert.equal(completed.result.indexRestored, false);
  assert.equal(completed.result.stashKept, false);
  assert.equal(git("diff", "--cached", "--name-only"), "");
  assert.equal((await tool("list_stashes", { repository })).items.length, 0);
  await openRepository(page, original);
}

export async function mcpSmoke({ page, exe, profile, work, restart }) {
  const child = spawn(exe, ["--mcp"], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, REVQORA_MULTI_INSTANCE: "1", WEBVIEW2_USER_DATA_FOLDER: profile },
  });
  const output = createInterface({ input: child.stdout });
  const pending = new Map();
  let id = 0, stderr = "";
  child.stderr.on("data", data => { stderr = (stderr + data).slice(-2000); });
  child.stdin.on("error", () => {});
  const rejectPending = error => { for (const { reject } of pending.values()) reject(error); };
  const exited = new Promise(resolve => {
    child.once("error", error => { rejectPending(error); resolve(); });
    child.once("exit", code => { rejectPending(new Error(`MCP process exited (${code}): ${stderr}`)); resolve(); });
  });
  output.on("line", line => {
    try {
      const response = JSON.parse(line);
      const waiting = pending.get(response.id);
      if (!waiting) throw new Error("Unexpected JSON-RPC response ID");
      if (response.error) waiting.reject(new Error(response.error.message));
      else waiting.resolve(response.result);
    } catch (error) { rejectPending(error); }
  });
  const rpc = (method, params) => {
    const request = ++id;
    return new Promise((resolve, reject) => {
      const remove = () => { clearTimeout(timer); pending.delete(request); };
      const fail = error => { remove(); reject(error); };
      const timer = setTimeout(() => fail(new Error(`MCP ${method} timed out: ${stderr}`)), 35_000);
      pending.set(request, { resolve: value => { remove(); resolve(value); }, reject: fail });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: request, method, params }) + "\n", error => { if (error) fail(error); });
    });
  };
  const rawTool = (name, args = {}) => rpc("tools/call", { name, arguments: args, _meta: { progressToken: id + 1 } });
  const tool = async (name, args) => {
    const result = await rawTool(name, args);
    if (result.isError) throw new Error(result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  const waitPhase = async (action, phase) => {
    const end = Date.now() + 20_000;
    let result;
    while (Date.now() < end) {
      result = await tool("action_status", { id: action });
      if (result.phase === phase) return result;
      if (["failed", "cancelled", "succeeded", "partial", "handed_off"].includes(result.phase)) break;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error(`MCP action did not reach ${phase}: ${JSON.stringify(result)}`);
  };
  const toggle = async enabled => {
    await page.getByTitle("Settings", { exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    const access = settings.getByRole("checkbox", { name: "Enable MCP", exact: true });
    // The controlled checkbox changes only after the native access request returns.
    await access.and(page.locator(enabled ? ":not(:checked):enabled" : ":checked:enabled")).waitFor();
    await access.click();
    await access.and(page.locator(enabled ? ":checked:enabled" : ":not(:checked):enabled")).waitFor();
    const config = await settings.getByLabel("Configuration", { exact: true }).inputValue();
    assert.match(config, /\[mcp_servers\.revqora\]/);
    assert.match(config, /args = \["--mcp"\]/);
    await settings.getByRole("button", { name: "Done", exact: true }).click();
  };
  const selectApproval = async (next, previous) => {
    await page.getByTitle("Settings", { exact: true }).click();
    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    const mode = settings.getByRole("combobox", { name: "Approval mode", exact: true });
    await mode.and(page.locator(":enabled")).waitFor();
    assert.equal(await mode.inputValue(), previous);
    if (next !== previous) {
      await mode.selectOption(next);
      await mode.and(page.locator(`:enabled:has(option[value=${next}]:checked)`)).waitFor();
    }
    await settings.getByRole("button", { name: "Done", exact: true }).click();
  };
  let fixture;
  try {
    const init = await rpc("initialize", { protocolVersion: "2025-11-25", clientInfo: { name: "Revqora smoke", version: "1" }, capabilities: {} });
    assert.equal(init.protocolVersion, "2025-11-25");
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const { tools } = await rpc("tools/list");
    assert(tools.some(entry => entry.name === "request_action"));
    assert.equal((await rawTool("list_repositories")).isError, true);
    await toggle(true);
    await page.locator(".topbar .repo-current > span").waitFor();
    const { active: root, repositories } = await tool("list_repositories");
    assert(root && repositories.some(item => item.id === root));
    const relative = path.relative(work, root);
    assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "Use only a repository created by the smoke test");
    assert.equal((await rawTool("repository_status", { repository: path.join(work, "unopened") })).isError, true);
    assert.equal((await rawTool("request_action", { repository: root, action: "stage", paths: ["file"], approved: true })).isError, true);
    const file = "revqora-mcp-stage-fixture.txt";
    fs.writeFileSync(path.join(root, file), "MCP stage fixture\n", { flag: "wx" });
    fixture = { root, file };
    const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trim();
    assert((await tool("repository_status", { repository: root })).files.items.some(row => row.path === file && row.untracked));
    const diff = await tool("file_diff", { repository: root, path: file, side: "unstaged" });
    assert(diff.hunks.some(hunk => hunk.lines.some(line => line.text.includes("MCP stage fixture"))));
    const approve = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "MCP request · Stage files" }) });
    const stage = () => tool("request_action", { repository: root, action: "stage", paths: [file] });
    const declined = await stage();
    await waitPhase(declined.id, "awaiting_confirmation");
    await approve.getByText(file, { exact: true }).waitFor();
    assert.equal(git("diff", "--cached", "--name-only", "--", file), "");
    await approve.getByRole("button", { name: "Decline", exact: true }).click();
    await waitPhase(declined.id, "cancelled");
    const approved = await stage();
    await approve.getByRole("button", { name: "Approve in Revqora", exact: true }).click();
    await waitPhase(approved.id, "succeeded");
    assert.equal(git("diff", "--cached", "--name-only", "--", file), file);

    const unstage = await tool("request_action", { repository: root, action: "unstage", paths: [file] });
    await page.getByRole("dialog", { name: "MCP request · Unstage files", exact: true }).getByRole("button", { name: "Approve in Revqora", exact: true }).click();
    await waitPhase(unstage.id, "succeeded");
    assert.equal(git("diff", "--cached", "--name-only", "--", file), "");
    const restage = await stage();
    await approve.getByRole("button", { name: "Approve in Revqora", exact: true }).click();
    await waitPhase(restage.id, "succeeded");

    const beforeHead = git("rev-parse", "HEAD");
    assert.equal(git("diff", "--cached", "--name-only"), file, "The smoke repository must have only the fixture staged");
    await tool("open_view", { repository: root, view: "changes" });
    await page.getByRole("button", { name: "Seal staged changes into a layer", exact: true }).click();
    await page.waitForSelector(".layer:not(.open-layer)");
    await page.waitForSelector(".changes[data-pending='false']");
    assert((await tool("repository_status", { repository: root })).files.items.some(row => row.path === file && row.index === "A"));
    const stagedDiff = await tool("file_diff", { repository: root, path: file, side: "staged" });
    assert(stagedDiff.hunks.some(hunk => hunk.lines.some(line => line.text.includes("MCP stage fixture"))));
    for (const args of [{ action: "unstage", paths: [file] }, { action: "commit", message: "Unexpected MCP commit" }]) {
      const request = await tool("request_action", { repository: root, ...args });
      const failed = await waitPhase(request.id, "failed");
      assert.match(failed.message, /sealed stage layers.*Changes/);
    }
    assert.equal(git("diff", "--cached", "--name-only"), file);
    assert.equal(git("rev-parse", "HEAD"), beforeHead);
    await page.locator(".layer:not(.open-layer) button[title='Unstage layer']").click();
    await page.waitForSelector(".layer:not(.open-layer)", { state: "detached" });
    await page.waitForSelector(".changes[data-pending='false']");
    assert.equal(git("diff", "--cached", "--name-only"), "");
    assert.equal(fs.readFileSync(path.join(root, file), "utf8"), "MCP stage fixture\n");
    await branchActions({page,work,tool,rawTool,waitPhase,original:root});
    await diffStageAndStash({ page, original: root, work, tool, rawTool, waitPhase });
    const oldAction = await approvalModes({ page, root, work, tool, waitPhase, selectApproval });
    page = await restart(root, async () => {
      const offline = await rawTool("action_status", { id: oldAction });
      assert.equal(offline.structuredContent.code, "desktop_closed");
    });
    const expired = await rawTool("action_status", { id: oldAction });
    assert.equal(expired.structuredContent.code, "session_expired");
    await selectApproval("delete_only", "delete_only");
    // Desktop startup does not wait for Git to finish loading the active tab.
    assert(Array.isArray((await tool("list_repositories")).repositories));
    await openRepository(page, root);
    await page.locator(".topbar .repo-current > span").waitFor();
    const restored = await tool("list_repositories");
    assert(restored.repositories.some(item => path.relative(root, item.id) === ""), "MCP must serve reads before opening Settings after restart");
    await toggle(false);
    assert.equal((await rawTool("list_repositories")).structuredContent.code, "mcp_disabled");
    page = await restart(root);
    assert.equal((await rawTool("list_repositories")).structuredContent.code, "mcp_disabled", "Disabling MCP must persist across restart");
  } finally {
    child.stdin.end();
    if (child.exitCode === null) child.kill();
    await exited;
    output.close();
    if (fixture) {
      const { root, file } = fixture;
      execFileSync("git", ["-C", root, "reset", "-q", "--", file], { windowsHide: true });
      fs.rmSync(path.join(root, file), { force: true });
    }
  }
}
