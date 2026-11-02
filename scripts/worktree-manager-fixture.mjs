// React derives the initial folder after a branch/mode change. Wait for that
// observable result before replacing it, then reject redirected/concatenated input.
export async function fillWorktreeFolder(page, dialog, suggested, destination) {
  await page.waitForFunction(expected => document.querySelector('input[aria-label="Worktree folder"]')?.value === expected, suggested);
  await dialog.getByRole("textbox", {name:"Worktree folder",exact:true}).fill(destination);
  await assertWorktreeFolder(dialog, destination);
}

export async function assertWorktreeFolder(dialog, expected) {
  const actual = await dialog.getByRole("textbox", {name:"Worktree folder",exact:true}).inputValue();
  if (actual !== expected) throw Error(`Worktree folder mismatch before review: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}; no review was requested`);
}
