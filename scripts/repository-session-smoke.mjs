import fs from "node:fs";
import path from "node:path";

/** Real Git repositories, with native discovery responses held to prove first paint
 * does not depend on their completion. No repository or task state is fabricated.
 */
export async function repositorySessionSmoke({ page, work, shot, template }) {
  const fixture = path.join(work, "forty-repositories"); fs.mkdirSync(fixture);
  const roots = Array.from({ length: 40 }, (_, i) => path.join(fixture, `${i < 20 ? "backend" : i < 37 ? "frontend" : "ungrouped"}-${i}`));
  for (const root of roots) fs.cpSync(template, root, { recursive: true });
  const previous = await page.evaluate(() => Object.fromEntries(["revqora.settings", "revqora.repositories"].map(key => [key, localStorage.getItem(key)])));
  await page.addInitScript(() => {
    if (localStorage.getItem("revqora.session-test") !== "hold") return;
    const original = window.fetch, held = [];
    const gate = { calls: [], held: 0, released: false, errors: [], started: performance.now(), firstRoster: null, firstOpening: null, rosterMs: null, release() { gate.released = true; held.splice(0).forEach(resolve => resolve()); } };
    window.__repositorySessionGate = gate;
    const observer = new MutationObserver(() => {
      const count = document.querySelectorAll(".repository-item").length;
      if (count) { gate.firstRoster = count; gate.firstOpening = document.querySelectorAll('[data-repository-state="opening"]').length; gate.rosterMs = performance.now() - gate.started; observer.disconnect(); }
    });
    observer.observe(document, { subtree: true, childList: true });
    const intercepted = async function(input, init) {
      const url = typeof input === "string" ? input : input?.url ?? String(input);
      if (/\/repo_open$/.test(url)) gate.calls.push(JSON.parse(init.body).path);
      const response = await Reflect.apply(original, window, [input, init]);
      if (/\/repo_open$/.test(url)) {
        if (!response.ok || response.headers.get("Tauri-Response") !== "ok") gate.errors.push("Native discovery failed");
        if (!gate.released) { gate.held++; await new Promise(resolve => held.push(resolve)); }
      }
      return response;
    };
    if (!Reflect.set(window, "fetch", intercepted) || window.fetch !== intercepted) throw Error("Could not install repository discovery response gate");
  });
  try {
    await page.evaluate(roots => {
      const settings = JSON.parse(localStorage.getItem("revqora.settings"));
      // Half the library was saved without open tabs. It must still be opened
      // in the first roster, including the three ungrouped repositories.
      settings.state.openTabs = roots.slice(0, 20); settings.state.activeTab = roots[19]; settings.state.autoFetchMinutes = 0;
      settings.state.openLibraryOnStartup = true;
      for (const layout of Object.values(settings.state.layouts)) { layout.repositoriesOpen = true; layout.focusMode = false; }
      localStorage.setItem("revqora.settings", JSON.stringify(settings));
      localStorage.setItem("revqora.repositories", JSON.stringify({ version: 1, state: { knownRoots: roots, favorites: [], groups: [{ id: "backend", name: "Backend", roots: roots.slice(0, 20), collapsed: false }, { id: "frontend", name: "Frontend", roots: roots.slice(20, 37), collapsed: false }], workspaces: [], activeWorkspaceId: null } }));
      localStorage.setItem("revqora.session-test", "hold");
    }, roots);
    const started = Date.now(); await page.reload();
    await page.waitForFunction(() => document.querySelector(".app")?.dataset.appStartup === "ready" && window.__repositorySessionGate?.held === 4);
    if (await page.locator(".repository-item").count() !== 40) throw Error("The complete saved roster did not appear before discovery finished");
    for (const [name, count] of [["Backend", 20], ["Frontend", 17], ["Ungrouped", 3]]) {
      const header = page.locator(".repository-group").filter({ hasText: name });
      if (await header.locator(".faint").innerText() !== String(count)) throw Error(`${name} did not immediately show ${count} repositories`);
    }
    if (await page.locator(".repository-select .faint").filter({ hasText: "Closed" }).count()) throw Error("Pending discovery was displayed as Closed");
    const first = await page.evaluate(() => ({ calls: window.__repositorySessionGate.calls, errors: window.__repositorySessionGate.errors, firstRoster: window.__repositorySessionGate.firstRoster, firstOpening: window.__repositorySessionGate.firstOpening, rosterMs: window.__repositorySessionGate.rosterMs, active: document.querySelector(".repo-current")?.title }));
    if (first.errors.length || first.firstRoster !== 40 || first.firstOpening !== 40 || first.active !== roots[19] || first.calls[0] !== roots[19]) throw Error(`Last active repository was not restored and prioritized: ${JSON.stringify(first)}`);
    console.log(`Complete 40-repository first roster: ${Math.round(first.rosterMs)}ms after document initialization`);
    await shot("session-40-before-discovery");
    await page.locator(".repository-item", { hasText: "frontend-35" }).locator(".repository-select").click();
    await page.evaluate(() => window.__repositorySessionGate.release());
    await page.waitForFunction(() => !document.querySelector('[data-repository-state="opening"]'));
    await page.locator(".history-mode").waitFor();
    const final = await page.evaluate(() => ({ active: document.querySelector(".repo-current")?.title, settings: JSON.parse(localStorage.getItem("revqora.settings")).state }));
    if (final.active !== roots[35] || final.settings.activeTab !== roots[35] || final.settings.openTabs.length !== 40) throw Error("Late discovery changed selection or saved a partial session");
    if (await page.locator('[data-repository-state="unavailable"]').count()) throw Error("A real fixture repository could not be opened");
    console.log(`40-repository native restore and selection verified in ${Date.now() - started}ms (including held-response assertions and screenshot)`);
    await shot("session-40-loaded");
    await page.locator(".repository-overview-link").click();
    await page.waitForFunction(() => {
      const rows = [...document.querySelectorAll(".repository-table tbody tr")];
      return rows.length === 40 && rows.every(row => row.children[3]?.textContent.trim() === "Clean");
    });
    await shot("session-40-overview");
    await page.locator(".repository-item", { hasText: "frontend-35" }).locator(".repository-select").click();
    // Start a new frontend session from its real saved settings, without
    // reinstalling the fixture or sending an explicit open-paths command.
    await page.evaluate(() => localStorage.removeItem("revqora.session-test"));
    await page.reload();
    await page.locator(".history-mode").waitFor();
    const restarted = await page.evaluate(() => ({ active: document.querySelector(".repo-current")?.title, count: document.querySelectorAll(".repository-item").length }));
    if (restarted.active !== roots[35] || restarted.count !== 40) throw Error("The next application session did not restore its last active repository and complete roster");
  } finally {
    await page.evaluate(previous => {
      window.__repositorySessionGate?.release();
      localStorage.removeItem("revqora.session-test");
      for (const [key, value] of Object.entries(previous)) if (value !== null) localStorage.setItem(key, value); else localStorage.removeItem(key);
    }, previous);
    await page.reload();
    await page.locator(".history-mode").waitFor();
  }
}
