// Diff options (wrap, whitespace, whole file, ignore whitespace) live in the diff's View menu.
// `on` undefined toggles; true/false sets. `scope` is the page or a locator around one diff.
export async function setDiffOption(scope, label, on) {
  const page = typeof scope.page === "function" ? scope.page() : scope;
  await scope.getByRole("button", { name: "Diff view options", exact: true }).first().click();
  const item = page.locator(".ctx-menu").getByRole("menuitemcheckbox", { name: label, exact: true });
  await item.waitFor();
  const checked = (await item.getAttribute("aria-checked")) === "true";
  if (on === undefined || checked !== on) await item.click();
  else await page.keyboard.press("Escape");
}

/** Whether the View menu offers an option (closes the menu again). */
export async function hasDiffOption(scope, label) {
  const page = typeof scope.page === "function" ? scope.page() : scope;
  await scope.getByRole("button", { name: "Diff view options", exact: true }).first().click();
  await page.locator(".ctx-menu").waitFor();
  const found = await page.locator(".ctx-menu").getByRole("menuitemcheckbox", { name: label, exact: true }).count() > 0;
  await page.keyboard.press("Escape");
  return found;
}
