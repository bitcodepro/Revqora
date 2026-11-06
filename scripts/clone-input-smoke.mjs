import fs from "node:fs";
import path from "node:path";
import {timedExecFileSync as execFileSync} from "./ci-timing.mjs";
import {repositoryIsActive} from "./ui-readiness.mjs";

export async function cloneInputSmoke({page,check,shot,work}){
  await check("clone dialog accepts copied git clone commands, preserves HTTPS usernames and clones quoted local sources",async()=>{
    const parent=path.join(work,"clone destinations"),source=path.join(work,"clone source.git");fs.mkdirSync(source);fs.mkdirSync(parent);
    const git=(root,...args)=>execFileSync("git",["-C",root,...args],{encoding:"utf8",windowsHide:true}).trim();
    git(source,"init","-qb","main");for(const [key,value] of [["user.name","Clone Tester"],["user.email","clone@example.invalid"],["commit.gpgsign","false"],["core.autocrlf","false"]])git(source,"config",key,value);
    fs.writeFileSync(path.join(source,".gitattributes"),"* text eol=lf\n");fs.writeFileSync(path.join(source,"file.txt"),"cloned content\n");git(source,"add",".");git(source,"commit","-qm","Clone fixture");const head=git(source,"rev-parse","HEAD"),index=fs.readFileSync(path.join(source,".git/index"));
    const open=async()=>{
      await page.getByTitle("Command palette (Ctrl+K)",{exact:true}).click();await page.waitForFunction(()=>document.activeElement===document.querySelector(".palette input")&&document.activeElement.value==="");await page.locator(".palette input").fill("Clone repository");await page.locator(".palette-item").filter({hasText:"Clone repository…"}).click();await page.getByRole("heading",{name:"Clone repository",exact:true}).waitFor();
    };
    const field=name=>page.getByRole("textbox",{name,exact:true});
    const waitName=name=>page.waitForFunction(name=>document.querySelector('[aria-label="Clone folder name"]').value===name,name);
    await open();
    const bitbucket="https://gorillatv@bitbucket.org/myrepos_webler/be-repos.git";
    await field("Repository URL").fill(`git clone ${bitbucket}`);await waitName("be-repos");
    await field("Clone parent folder").fill(parent);
    if(await field("Repository URL").inputValue()!==`git clone ${bitbucket}`)throw Error("Blur rewrote the raw clone input, risking a second command parse");
    await shot("clone-bitbucket-command");
    await field("Repository URL").fill(`git clone --depth 1 ${bitbucket}`);await page.getByRole("alert").filter({hasText:"command options and extra arguments"}).waitFor();
    if(!await page.getByRole("button",{name:"Clone",exact:true}).isDisabled())throw Error("Unsupported command arguments were silently ignored");
    // No real Bitbucket credentials or network access are needed to test transport.
    const literal=source.replaceAll("\\","/");
    for(const [input,name] of [[`git clone "${literal}"`,"quoted clone"],[literal,"plain clone"]]){
      if(name==="plain clone")await open();
      await field("Repository URL").fill(input);await waitName("clone source");
      await field("Clone parent folder").fill(parent);await field("Clone folder name").fill(name);
      await page.getByRole("button",{name:"Clone",exact:true}).click();
      const root=path.join(parent,name);
      await page.waitForFunction(repositoryIsActive,{expected:root,windows:process.platform==="win32"});
      if(git(root,"rev-parse","HEAD")!==head||git(root,"config","--get","remote.origin.url")!==literal||fs.readFileSync(path.join(root,"file.txt"),"utf8")!=="cloned content\n")throw Error("Clone command did not create the expected repository and literal remote");
    }
    // Both possible sources exist, so a second parse would silently succeed on
    // the wrong repository rather than merely returning a clone error.
    for(const name of ["demo.git","git clone demo.git","'quoted repo.git"," leading repo.git"]){
      const local=path.join(parent,name);git(parent,"clone","--no-local",source,local);
      fs.writeFileSync(path.join(local,"marker.txt"),name);git(local,"-c","user.name=Clone Tester","-c","user.email=clone@example.invalid","-c","commit.gpgsign=false","add","marker.txt");git(local,"-c","user.name=Clone Tester","-c","user.email=clone@example.invalid","-c","commit.gpgsign=false","commit","-qm",`Source ${name}`);
    }
    for(const [i,relative] of ["git clone demo.git","'quoted repo.git"," leading repo.git"].entries()){
      await open();const raw=`git clone "${relative}"`;await field("Repository URL").fill(raw);
      await field("Clone parent folder").fill(parent);await field("Clone folder name").fill(`literal-${i}`);
      if(await field("Repository URL").inputValue()!==raw)throw Error("Blur changed a command-like, quoted or whitespace-prefixed source");
      await page.getByRole("button",{name:"Clone",exact:true}).click();const destination=path.join(parent,`literal-${i}`);
      await page.waitForFunction(repositoryIsActive,{expected:destination,windows:process.platform==="win32"});
      const remote=execFileSync("git",["-C",destination,"config","--get","remote.origin.url"],{encoding:"utf8",windowsHide:true}).replace(/\r?\n$/,"");
      if(git(destination,"rev-parse","HEAD")!==git(path.join(parent,relative),"rev-parse","HEAD")||path.normalize(remote)!==path.normalize(path.join(parent,relative))||fs.readFileSync(path.join(destination,"marker.txt"),"utf8")!==relative)throw Error("Blur/submit cloned a different local repository");
    }
    if(!fs.readFileSync(path.join(source,".git/index")).equals(index)||git(source,"rev-parse","HEAD")!==head)throw Error("Cloning modified the source repository");
    await shot("clone-command-result");
  });
}
