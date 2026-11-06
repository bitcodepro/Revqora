import assert from "node:assert/strict";
import path from "node:path";

// Exercise real rendered context menus without reading or replacing the user's
// OS clipboard. Probe the test interception immediately, never wait on a hook
// that may not have installed (e.g. a read-only native property).
export async function namePathCopySmoke({page,root}) {
  const repoName=path.basename(root);
  await page.evaluate(async()=>{
    const previous=Object.getOwnPropertyDescriptor(navigator,"clipboard");
    window.__namePathCopies=[];
    Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async text=>{window.__namePathCopies.push(text);}}});
    window.__restoreNamePathClipboard=()=>{if(previous)Object.defineProperty(navigator,"clipboard",previous);else delete navigator.clipboard;delete window.__namePathCopies;delete window.__restoreNamePathClipboard;};
    await navigator.clipboard.writeText("interception probe");
    if(window.__namePathCopies.pop()!=="interception probe")throw new Error("Clipboard interception was not installed");
  });
  const copy=async(target,name)=>{
    for(const [label,expected] of [["Copy name",name],["Copy path",root]]) {
      await target.click({button:"right"});
      await page.locator(".ctx-menu").getByText(label,{exact:true}).click();
      await page.waitForFunction(expected=>window.__namePathCopies.at(-1)===expected,expected);
      assert.equal(await page.locator(".topbar .repo-current > b").innerText(),repoName,"Right click/copy must not activate another repository");
    }
  };
  const toggle=page.getByTitle("Toggle branches panel",{exact:true});
  const branchesWereOpen=await toggle.getAttribute("aria-expanded")==="true";
  try {
    if(!branchesWereOpen)await toggle.click();
    await copy(page.locator(".topbar .repo-current > b"),repoName);
    await copy(page.locator(".topbar .repo-current > span"),"main");
    await copy(page.locator(".repository-select").filter({hasText:repoName}),repoName);
    await copy(page.locator('.sidebar [data-branch-kind="local"][data-branch-name="main"]'),"main");
    await copy(page.locator(".graph-scroll .ref.head").filter({hasText:"main"}).first(),"main");
    await page.getByRole("button",{name:"Open branch manager",exact:true}).click();
    const main=page.locator('[data-branch-ref="refs/heads/main"]');
    await copy(main,"main");
    await main.click();await copy(page.locator(".bm-detail h3"),"main");
    await copy(page.locator('[data-branch-ref="refs/remotes/origin/main"]'),"origin/main");
    await page.getByRole("button",{name:"Close branch manager",exact:true}).click();
    await page.getByRole("button",{name:"Open worktree manager",exact:true}).click();
    const worktree=page.locator("[data-worktree-path]").filter({has:page.getByText(root,{exact:true})});
    await copy(worktree.locator("b"),"main");
    await copy(worktree.locator(".mono"),repoName);
    await page.getByRole("button",{name:"Close worktree manager",exact:true}).click();
    await page.getByRole("button",{name:"Repository library and workspaces",exact:true}).click();
    await copy(page.locator(".library-row").filter({has:page.getByText(repoName,{exact:true})}),repoName);
    await page.locator(".modal").last().getByRole("button",{name:"Done",exact:true}).click();
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
    console.log("Copy name/path: headers, sidebar, graph, manager, library and overview passed");
  } finally {
    await page.evaluate(()=>window.__restoreNamePathClipboard?.());
    if(!branchesWereOpen&&await toggle.isVisible()&&await toggle.getAttribute("aria-expanded")==="true")await toggle.click();
  }
}
