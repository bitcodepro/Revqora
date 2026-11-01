import fs from "node:fs";
import path from "node:path";

// Forced taskkill /F is a crash, not a settings-flush barrier. History is native
// portable data: open its repository explicitly without recreating any records.
export async function openAgentRepository(page, root) {
  await page.evaluate(p => window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event: "open-paths", payload: [p] }), root);
  await page.locator(".topbar .repo-current > b").filter({ hasText: path.basename(root) }).waitFor();
}

// Check the real controls before preparing a launch, never silently refill a
// wrong field or wait for a preview that cannot be produced from this form.
export async function assertAgentDraft(dialog, expected) {
  for (const [name, value, role] of [
    ["Task title", expected.title, "textbox"],
    ["Agent provider", "custom", "combobox"],
    ["Agent executable", expected.executable, "textbox"],
    ["Agent arguments", JSON.stringify(expected.args), "textbox"],
    ["Agent prompt", expected.prompt, "textbox"],
  ]) {
    if (await dialog.getByRole(role, { name, exact: true }).inputValue() !== value) {
      throw Error(`Agent form field ${JSON.stringify(name)} does not contain the intended fixture value; no launch was prepared.`);
    }
  }
}

const physical = value => {
  const resolved = fs.realpathSync.native(path.resolve(value));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

// -z keeps Git's paths and lock reasons literal, regardless of core.quotepath.
// A lock on some other worktree must never satisfy the agent-task assertion.
export function assertAgentWorktreeProtection(git, task, expectedHead) {
  const expectedPath = physical(task.path);
  const raw = git("worktree", "list", "--porcelain", "-z");
  const records = raw.split("\0\0").filter(Boolean).map(block => new Map(block.split("\0").filter(Boolean).map(field => {
    const space = field.indexOf(" ");
    return space < 0 ? [field, ""] : [field.slice(0, space), field.slice(space + 1)];
  })));
  const row = records.find(record => {
    const registered = record.get("worktree");
    if (!registered || !fs.existsSync(registered)) return false;
    return physical(registered) === expectedPath;
  });
  if (!row) throw Error(`Agent worktree is not registered: ${task.path}`);
  if (row.get("branch") !== `refs/heads/${task.branch}`) throw Error(`Agent worktree has the wrong branch: ${row.get("branch")}`);
  if (row.get("HEAD") !== expectedHead) throw Error(`Agent worktree has the wrong HEAD: ${row.get("HEAD")}`);
  const prefix = `Agent task ${task.id}`, reason = row.get("locked");
  if (reason !== prefix && !reason?.startsWith(prefix + " ")) throw Error(`Agent worktree is not locked for task ${task.id}: ${JSON.stringify(reason ?? null)}`);
  return row;
}
