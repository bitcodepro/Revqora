import assert from "node:assert/strict";
import path from "node:path";
import { timedExecFileSync as execFileSync } from "./ci-timing.mjs";

// Exercise real rendered context menus without reading or replacing the user's
// OS clipboard. Probe the test interception immediately, never wait on a hook
// that may not have installed (e.g. a read-only native property).
export async function interceptClipboard(page) {
  await page.evaluate(async()=>{
    const previous=Object.getOwnPropertyDescriptor(navigator,"clipboard");
    window.__namePathCopies=[];
    Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async text=>{window.__namePathCopies.push(text);}}});
    window.__restoreNamePathClipboard=()=>{if(previous)Object.defineProperty(navigator,"clipboard",previous);else delete navigator.clipboard;delete window.__namePathCopies;delete window.__restoreNamePathClipboard;};
    await navigator.clipboard.writeText("interception probe");
    if(window.__namePathCopies.pop()!=="interception probe")throw new Error("Clipboard interception was not installed");
  });
}

export async function namePathCopySmoke({page,root}) {
  const repoName=path.basename(root);
  // A registered tab can be active before its repository info is loaded.
  // Until then the disabled toggle reports false even for an open layout.
  const toggle=page.getByRole("button",{name:"Toggle branches panel",exact:true}).and(page.locator(":enabled"));
  await toggle.waitFor();
  const branchesWereOpen=await toggle.getAttribute("aria-expanded")==="true";
  const mainBranch=page.locator('.sidebar [data-branch-kind="local"][data-branch-name="main"]');
  await interceptClipboard(page);
  const copy=async(target,name)=>{
    for(const [label,expected] of [["Copy name",name],["Copy path",root]]) {
      await target.click({button:"right"});
      await page.locator(".ctx-menu").getByText(label,{exact:true}).click();
      await page.waitForFunction(expected=>window.__namePathCopies.at(-1)===expected,expected);
      assert.equal(await page.locator(".topbar .repo-current > b").innerText(),repoName,"Right click/copy must not activate another repository");
    }
  };
  try {
    if(!branchesWereOpen)await toggle.click();
    await toggle.and(page.locator('[aria-expanded="true"]')).waitFor();
    await mainBranch.waitFor();
    await copy(page.locator(".topbar .repo-current > b"),repoName);
    await copy(page.locator(".topbar .repo-current > span"),"main");
    await copy(page.locator(".repository-select").filter({hasText:repoName}),repoName);
    await copy(mainBranch,"main");
    await copy(page.locator(".graph-scroll .ref.head").filter({hasText:"main"}).first(),"main");
    await page.getByRole("button",{name:"Open branch manager",exact:true}).click();
    const manager=page.getByRole("region",{name:"Branch manager",exact:true});
    const main=manager.locator('[data-branch-ref="refs/heads/main"]');
    await copy(main,"main");
    await main.click();await copy(manager.locator(".bm-detail h3"),"main");
    await copy(manager.locator('[data-branch-ref="refs/remotes/origin/main"]'),"origin/main");
    await page.getByRole("button",{name:"Close branch manager",exact:true}).click();
    await page.getByRole("button",{name:"Open worktree manager",exact:true}).click();
    const worktree=page.locator("[data-worktree-path]").filter({has:page.getByText(root,{exact:true})});
    await copy(worktree.locator("b"),"main");
    await copy(worktree.locator(".mono"),repoName);
    await page.getByRole("button",{name:"Close worktree manager",exact:true}).click();
    await page.getByRole("button",{name:"Repository library",exact:true}).click();
    await copy(page.locator(".library-row").filter({has:page.getByText(repoName,{exact:true})}),repoName);
    const librarySearch=page.getByRole("textbox",{name:"Find saved repository",exact:true});
    // Use the actual search control; Escape must leave both dialog and filter intact.
    const search=await librarySearch.count()?librarySearch:page.locator(".modal input").first();
    await search.fill(repoName);
    await page.locator(".library-row").filter({has:page.getByText(repoName,{exact:true})}).click({button:"right"});
    await page.locator(".ctx-menu").waitFor();await page.keyboard.press("Escape");
    await page.locator(".ctx-menu").waitFor({state:"detached"});
    assert.equal(await search.inputValue(),repoName,"First Escape must retain the library search");
    await page.keyboard.press("Escape");await page.locator(".modal").waitFor({state:"detached"});
    await mainBranch.click({button:"right"});
    await page.locator(".ctx-menu").getByText("Branch details…",{exact:true}).click();
    await page.locator(".modal").last().waitFor();
    await page.locator(".modal").last().locator("h3 > span").click({button:"right"});await page.locator(".ctx-menu").waitFor();
    await page.keyboard.press("Escape");await page.locator(".ctx-menu").waitFor({state:"detached"});
    assert.equal(await page.locator(".modal").count(),1,"First Escape must retain Branch details");
    await page.keyboard.press("Escape");await page.locator(".modal").waitFor({state:"detached"});
    // A nested branch context menu must stop propagation to its repository row.
    await page.locator(".topbar").getByRole("button",{name:"All repositories",exact:true}).click();
    const row=page.locator(".repository-table tbody tr").filter({has:page.getByRole("button",{name:repoName,exact:true})});
    for(const [target,name] of [[row.locator("td").nth(0),repoName],[row.locator("td").nth(1),"main"]]) {
      for(const [label,expected] of [["Copy name",name],["Copy path",root]]) {
        await target.click({button:"right"});await page.locator(".ctx-menu").getByText(label,{exact:true}).click();
        await page.waitForFunction(expected=>window.__namePathCopies.at(-1)===expected,expected);
      }
    }
    await row.getByRole("button",{name:repoName,exact:true}).click();
    const git=(...args)=>execFileSync("git",["-C",root,...args],{encoding:"utf8",windowsHide:true}).trim();
    const originalUrl=git("remote","get-url","origin");
    try {
      git("remote","set-url","origin","https://fixture-user:fixture-password@github.com/example/project.git");
      for (const [target,expected] of [
        [page.locator(".topbar .repo-current > b"),"https://github.com/example/project"],
        [page.locator(".topbar .repo-current > span"),"https://github.com/example/project/tree/main"],
      ]) {
        await target.click({button:"right"});
        await page.locator(".ctx-menu").getByText("Copy URL",{exact:true}).click();
        await page.waitForFunction(expected=>window.__namePathCopies.at(-1)===expected,expected);
      }
    } finally {
      git("remote","set-url","origin",originalUrl);
    }
    console.log("Copy name, path and URL context menus passed");
  } finally {
    await page.evaluate(()=>window.__restoreNamePathClipboard?.());
    if(!branchesWereOpen&&await toggle.isVisible()&&await toggle.getAttribute("aria-expanded")==="true")await toggle.click();
  }
}
