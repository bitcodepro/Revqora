import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { timedExecFileSync as execFileSync } from "./ci-timing.mjs";
import { openRepository } from "./ui-readiness.mjs";

async function branchActions({ page, work, tool, rawTool, waitPhase, original }) {
  const root = path.join(work, "mcp-branch-fixture");
  fs.mkdirSync(root);
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trimEnd();
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
    ["Proposed message", "#TEST-2: Approved message\n\nKeep the body.\n# Literal detail"],
  ]) {
    const action = await request("commit", {message:proposed});
    const dialog = approval("Commit staged changes");
    const message = dialog.getByRole("textbox", {name:"Commit message",exact:true});
    assert.equal(await message.inputValue(), proposed);
    if (proposed !== approved) await message.fill(approved);
    await approve(dialog);
    const result = await waitPhase(action.id, "succeeded");
    assert.equal(result.result.sha, git("rev-parse", "HEAD"));
    assert.equal(git("log", "-1", "--format=%B"), approved);
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
      if (["failed", "cancelled", "succeeded", "handed_off"].includes(result.phase)) break;
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
    page = await restart(root);
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
