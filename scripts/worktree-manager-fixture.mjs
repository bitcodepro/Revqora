import fs from "node:fs";
import path from "node:path";

const folder = dialog => dialog.getByRole("textbox", { name: "Worktree folder", exact: true });

async function creationError(dialog, step, cause) {
  const form = await dialog.evaluate(element => ({
    folder: element.querySelector('input[aria-label="Worktree folder"]')?.value ?? null,
    mode: element.querySelector(".seg button.on")?.textContent ?? null,
    branch: element.querySelector('select[aria-label="Worktree branch"], input[aria-label="New worktree branch"]')?.value ?? null,
    message: element.querySelector('[role="alert"]')?.textContent ?? null,
  }), undefined, { timeout: 1000 }).catch(() => null);
  return new Error(`Worktree ${step} failed: ${cause.message}. Form: ${JSON.stringify(form)}`, { cause });
}

// The existing-branch dialog selects its first available branch after loading.
// Wait for the resulting suggestion before replacing it with the test path.
export async function fillWorktreeFolder(page, dialog, root, destination, name) {
  try {
    await page.waitForFunction(({ root, name }) => {
      const branch = name ?? document.querySelector('select[aria-label="Worktree branch"]')?.value;
      const input = document.querySelector('input[aria-label="Worktree folder"]');
      if (!branch || !input?.matches(":enabled")) return false;
      const parent = root.replace(/[\\/][^\\/]+$/, "");
      const repo = root.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
      return input.value === `${parent}/${repo}-${branch.replace(/[\\/]/g, "-")}`;
    }, { root, name });
    await folder(dialog).fill(destination);
    await assertWorktreeFolder(dialog, destination);
  } catch (error) {
    throw await creationError(dialog, "folder input", error);
  }
}

export async function assertWorktreeFolder(dialog, expected) {
  const actual = await folder(dialog).inputValue();
  if (actual !== expected) {
    throw new Error(`Worktree folder mismatch before review: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}; no review was requested`);
  }
}

export async function reviewWorktreeCreation(dialog, destination) {
  try {
    await assertWorktreeFolder(dialog, destination);
    const review = dialog.locator('[data-worktree-review="create"]');
    const alert = dialog.getByRole("alert");
    await dialog.getByRole("button", { name: "Review creation", exact: true }).click();
    await review.or(alert).first().waitFor();
    if (await alert.isVisible()) throw new Error(await alert.innerText());

    // The backend canonicalizes the existing parent before displaying the path.
    const expected = path.join(fs.realpathSync.native(path.dirname(destination)), path.basename(destination));
    const actual = await review.locator("code").first().innerText();
    const key = value => process.platform === "win32" ? path.normalize(value).toLowerCase() : path.normalize(value);
    if (key(actual) !== key(expected)) {
      throw new Error(`Reviewed destination mismatch: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
    return review;
  } catch (error) {
    throw await creationError(dialog, "creation review", error);
  }
}
