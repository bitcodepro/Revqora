import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { timedExecFileSync as execFileSync } from "./ci-timing.mjs";

export async function mcpSmoke({ page, exe, profile, work }) {
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
      const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out: ${stderr}`)), 35_000);
      pending.set(request, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: request, method, params }) + "\n");
      const remove = () => { clearTimeout(timer); pending.delete(request); };
      const waiting = pending.get(request);
      waiting.resolve = value => { remove(); resolve(value); };
      waiting.reject = error => { remove(); reject(error); };
      timer.refresh();
    }).finally(() => pending.delete(request));
  };
  const rawTool = (name, args = {}) => rpc("tools/call", { name, arguments: args });
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
  const settings = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Settings", exact: true }) });
  const access = settings.getByRole("checkbox", { name: "Enable MCP for this session" });
  const toggle = async enabled => {
    await page.getByTitle("Settings", { exact: true }).click();
    await access.setChecked(enabled);
    await page.waitForFunction(expected => {
      const input = document.querySelector("#mcp-enabled");
      return input && !input.disabled && input.checked === expected;
    }, enabled);
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
    const { active: root, repositories } = await tool("list_repositories");
    assert(root && repositories.some(item => item.id === root));
    const relative = path.relative(work, root);
    assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "Use only a repository created by the smoke test");
    assert.equal((await rawTool("repository_status", { repository: path.join(work, "unopened") })).isError, true);
    assert.equal((await rawTool("request_action", { repository: root, action: "stage", paths: ["file"], approved: true })).isError, true);
    const file = "revqora-mcp-stage-fixture.txt";
    fixture = { root, file };
    fs.writeFileSync(path.join(root, file), "MCP stage fixture\n", { flag: "wx" });
    const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", windowsHide: true }).trim();
    assert((await tool("repository_status", { repository: root })).files.items.some(row => row.path === file && row.untracked));
    const diff = await tool("file_diff", { repository: root, path: file, side: "unstaged" });
    assert(diff.hunks.some(hunk => hunk.lines.some(line => line.text.includes("MCP stage fixture"))));
    const approve = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "MCP request · Stage files" }) });
    const stage = () => tool("request_action", { repository: root, action: "stage", paths: [file] });
    const declined = await stage();
    await approve.getByText(file, { exact: true }).waitFor();
    assert.equal(git("diff", "--cached", "--name-only", "--", file), "");
    await approve.getByRole("button", { name: "Decline", exact: true }).click();
    await waitPhase(declined.id, "cancelled");
    const approved = await stage();
    await approve.getByRole("button", { name: "Approve in Revqora", exact: true }).click();
    await waitPhase(approved.id, "succeeded");
    assert.equal(git("diff", "--cached", "--name-only", "--", file), file);
    await toggle(false);
    assert.equal((await rawTool("list_repositories")).isError, true);
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
