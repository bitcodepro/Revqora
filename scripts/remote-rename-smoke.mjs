import { openSubmenu } from "./ui-driver.mjs";

// Shared by the core suite and a focused run: preserve the real server-SHA,
// renewed-consent and explicit-upstream-repair assertions when rows are paired.
export async function remoteRenameSmoke({ page, check, shot, git, server, base, until }) {
  const filter = page.locator(".sidebar input[placeholder^='Filter branches']");
  const openRename = async (oldName, newName, pairedLocal = null) => {
    const branches=page.getByRole("button",{name:"Toggle branches panel",exact:true});
    if(await branches.getAttribute("aria-expanded")==="false")await branches.click();
    await filter.waitFor({state:"visible"});await filter.fill(oldName);
    const rename=page.locator(".ctx-item").filter({has:page.getByText("Rename on remote…",{exact:true})});
    if(pairedLocal){
      const local=page.locator(`[data-branch-kind='local'][data-branch-name='${pairedLocal}']`);
      const upstream=page.locator(".ctx-item").filter({has:page.getByText(`Upstream: origin/${oldName}`,{exact:true})});
      await openSubmenu(page,()=>local.click({button:"right"}),upstream,rename);
    }else{
      await page.locator(`[data-branch-kind='remote'][data-branch-name='origin/${oldName}']`).click({button:"right"});
    }
    await rename.click();
    await page.fill("input[aria-label='New remote branch name']",newName);
    await page.locator(".modal").last().getByRole("button",{name:"Review rename",exact:true}).click();
    await page.waitForSelector(".modal input[type='checkbox']");
  };
  await check("remote rename reviews the server SHA and offers explicit local upstream repair",async()=>{
    await openRename("topic-old","topic-renamed","main");
    if(!(await page.locator(".modal").last().innerText()).includes(base))throw new Error("review did not show the server commit");
    const confirm=page.locator(".modal").last().getByRole("button",{name:"Rename on server",exact:true});
    if(!await confirm.isDisabled())throw new Error("rename allowed without explicit confirmation");
    await page.locator(".modal input[type='checkbox']").check();await shot("57-remote-rename-review");await confirm.click();
    await page.waitForSelector(".modal:has-text('The server branch was renamed')",{timeout:30000});
    if(server("rev-parse","refs/heads/topic-renamed")!==base||server("for-each-ref","--format=%(refname)","refs/heads/topic-old"))throw new Error("server rename was not exact");
    if(git("config","branch.main.merge")!=="refs/heads/topic-old")throw new Error("upstream was silently changed");
    await page.getByRole("button",{name:"Use renamed upstream",exact:true}).click();
    await until(()=>git("config","branch.main.merge")==="refs/heads/topic-renamed","explicit upstream update failed",15000);
    await page.locator(".modal").last().getByRole("button",{name:"Close",exact:true}).click();await filter.fill("");
  });
  await check("a changed remote tip clears rename consent and requires a fresh server review",async()=>{
    server("update-ref","refs/heads/stale-old",base);git("push","origin","HEAD:refs/heads/seed");git("fetch","origin");
    await page.click("button[title='Refresh (F5)']");await page.locator(".sidebar [data-branch-kind='remote'][data-branch-name='origin/stale-old']").waitFor();
    await openRename("stale-old","stale-new");
    const advanced=git("rev-parse","HEAD");if(advanced===base)throw new Error("Stale rename fixture requires distinct old and new server tips");server("update-ref","refs/heads/stale-old",advanced);
    await page.locator(".modal input[type='checkbox']").check();await page.locator(".modal").last().getByRole("button",{name:"Rename on server",exact:true}).click();
    await page.locator(".modal").last().getByRole("button",{name:"Review rename",exact:true}).waitFor();
    if(server("rev-parse","refs/heads/stale-old")!==advanced||server("for-each-ref","--format=%(refname)","refs/heads/stale-new"))throw new Error("stale consent changed server refs");
    await page.locator(".modal").last().getByRole("button",{name:"Review rename",exact:true}).click();await page.waitForSelector(".modal input[type='checkbox']");
    if(!(await page.locator(".modal").last().innerText()).includes(advanced)||await page.locator(".modal input[type='checkbox']").isChecked())throw new Error("fresh review reused the old SHA or consent");
    await page.locator(".modal input[type='checkbox']").check();await page.locator(".modal").last().getByRole("button",{name:"Rename on server",exact:true}).click();
    await page.waitForSelector(".modal:has-text('The server branch was renamed')",{timeout:30000});
    if(server("rev-parse","refs/heads/stale-new")!==advanced)throw new Error("fresh rename moved the wrong commit");
    await shot("58-remote-rename-complete");await page.locator(".modal").last().getByRole("button",{name:"Close",exact:true}).click();await filter.fill("");
  });
}
