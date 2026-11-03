import fs from "node:fs";
import path from "node:path";

// A displayed stash is an immutable snapshot, even when Git renumbers its list.
export async function stashSnapshotSmoke({page,root,git,until}) {
  const file=path.join(root,"README.md"),original=fs.readFileSync(file),head=git("rev-parse","HEAD"),index=git("ls-files","--stage");
  fs.writeFileSync(file,"old stash audit payload\n");git("stash","push","-m","snapshot-before-renumbering","--","README.md");
  const oid=git("rev-parse","stash@{0}");
  try {
    await page.locator(".sidebar .sb-item").filter({hasText:"snapshot-before-renumbering"}).click();
    await page.locator(".conflict-overlay .diff-body").filter({hasText:"old stash audit payload"}).waitFor();
    fs.writeFileSync(file,"new stash audit payload\n");git("stash","push","-m","snapshot-after-renumbering","--","README.md");
    fs.writeFileSync(file,"current user data\n");
    await page.locator(".sidebar .sb-item").filter({hasText:"snapshot-after-renumbering"}).waitFor();
    await page.locator(".conflict-overlay .diff-body").filter({hasText:"old stash audit payload"}).waitFor();
    await page.locator(".conflict-overlay").getByRole("button",{name:"Restore file",exact:true}).click();
    // A concurrent preview read does not acknowledge the queued mutation.
    // Observe the actual disk write before asserting which snapshot was used.
    await until(()=>fs.readFileSync(file,"utf8")!=="current user data\n","Stash file restoration did not finish");
    const actual=fs.readFileSync(file,"utf8");
    if(actual!=="old stash audit payload\n")throw Error(`Displayed stash restored a different snapshot: ${JSON.stringify(actual)}`);
    if(git("rev-parse","HEAD")!==head||git("ls-files","--stage")!==index)throw Error("Single-file stash restore changed HEAD or staging");
    // The original selector now names the newer stash: neither apply nor drop may use it.
    for(const command of ["stash_apply","stash_drop"]) {
      const result=await page.evaluate(async ({root,oid,command})=>{
        const invoke=window.__TAURI_INTERNALS__.invoke,state=await invoke("status",{repo:root});
        try{await invoke(command,{repo:root,index:0,oid,pop:false,expectedState:state.stateToken});return null;}catch(e){return e;}
      },{root,oid,command});
      if(result?.kind!=="stale-operation")throw Error(`${command} accepted a renumbered selector: ${JSON.stringify(result)}`);
      if(git("rev-parse","stash@{1}")!==oid||fs.readFileSync(file,"utf8")!==actual)throw Error(`${command} mutated data after rejecting the stale stash`);
    }
    await page.locator(".conflict-overlay").getByRole("button",{name:"Close",exact:true}).click();
  } finally {
    fs.writeFileSync(file,original);
    for(const message of ["snapshot-after-renumbering","snapshot-before-renumbering"]){
      const entry=git("stash","list","--format=%gd %gs").split("\n").find(line=>line.includes(message));
      if(entry)git("stash","drop",entry.split(" ")[0]);
    }
  }
}
