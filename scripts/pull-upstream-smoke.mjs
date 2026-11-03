import fs from "node:fs";
import path from "node:path";
import {timedExecFileSync as execFileSync} from "./ci-timing.mjs";

export async function pullUpstreamSmoke({page,check,shot,work}) {
  await check("Pull reconciles a server-deleted branch and continues on its actual default without losing local work",async()=>{
    const remote=path.join(work,"pull-upstream-server"),root=path.join(work,"pull-upstream-client");
    const git=(p,...args)=>execFileSync("git",["-C",p,...args],{encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","pipe"]}).trim();
    fs.mkdirSync(remote);git(remote,"init","-qb","main");
    for(const [key,value]of [["user.name","Pull fixture"],["user.email","pull@example.invalid"],["commit.gpgsign","false"],["core.autocrlf","false"],["core.hooksPath",".git/hooks"]])git(remote,"config",key,value);
    fs.writeFileSync(path.join(remote,"file.txt"),"base\n");git(remote,"add",".");git(remote,"commit","-qm","base");
    git(remote,"clone","-q",remote,root);git(root,"config","user.name","Pull fixture");git(root,"config","user.email","pull@example.invalid");git(root,"config","commit.gpgsign","false");git(root,"config","core.autocrlf","false");git(root,"config","core.hooksPath",".git/hooks");
    git(root,"checkout","-qb","feature/completed");fs.writeFileSync(path.join(root,"feature.txt"),"feature\n");git(root,"add",".");git(root,"commit","-qm","feature");git(root,"push","-qu","origin","feature/completed");
    git(remote,"merge","--squash","feature/completed");git(remote,"commit","-qm","squash feature");git(remote,"branch","-D","feature/completed");
    const merged=git(remote,"rev-parse","HEAD"),before=git(root,"rev-parse","HEAD"),index=fs.readFileSync(path.join(root,".git/index"));
    fs.writeFileSync(path.join(root,"file.txt"),"uncommitted user work\n");
    await page.evaluate(p=>window.__TAURI_INTERNALS__.invoke("plugin:event|emit",{event:"open-paths",payload:[p]}),root);
    await page.locator(".topbar .repo-current > b").filter({hasText:"pull-upstream-client"}).waitFor();
    await page.locator('.topbar button[title="Pull"]').click();
    await page.getByText("Upstream unavailable; repository refreshed",{exact:true}).waitFor();
    if(git(root,"rev-parse","HEAD")!==before||git(root,"branch","--show-current")!=="feature/completed"||!index.equals(fs.readFileSync(path.join(root,".git/index")))||fs.readFileSync(path.join(root,"file.txt"),"utf8")!=="uncommitted user work\n")throw Error("Deleted-upstream reconciliation changed local branch, staging or working files");
    if(git(root,"rev-parse","origin/main")!==merged||git(root,"for-each-ref","--format=%(refname)","refs/remotes/origin/feature/completed"))throw Error("Pull did not refresh main and prune its deleted remote branch");
    await page.getByRole("button",{name:"Continue on main",exact:true}).click();
    await page.getByText("Pulled",{exact:true}).waitFor();
    if(git(root,"rev-parse","HEAD")!==merged||git(root,"branch","--show-current")!=="main"||fs.readFileSync(path.join(root,"file.txt"),"utf8")!=="uncommitted user work\n"||git(root,"rev-parse","feature/completed")!==before)throw Error("Continuing on the default branch lost local work/history or did not pull main");
    await shot("pull-deleted-upstream-reconciled");
  });
}
