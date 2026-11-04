import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFileSync} from "node:child_process";

for(const autocrlf of ["true","false"]){
  test(`deleted-upstream UI fixture preserves its dirty file across main checkout with inherited autocrlf=${autocrlf}`,()=>{
    const base=path.resolve(process.env.REVQORA_TEST_TMP||os.tmpdir());fs.mkdirSync(base,{recursive:true});
    const work=fs.mkdtempSync(path.join(base,"pull-fixture-")),globalConfig=path.join(work,"gitconfig");
    fs.writeFileSync(globalConfig,`[core]\n\tautocrlf = ${autocrlf}\n`);
    const script=`
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import path from "node:path";
      import {execFileSync} from "node:child_process";
      import {pullUpstreamSmoke} from ${JSON.stringify(new URL("./pull-upstream-smoke.mjs",import.meta.url).href)};
      const work=process.env.PULL_FIXTURE_WORK,stop={},git=(root,...args)=>execFileSync("git",["-C",root,...args],{encoding:"utf8",windowsHide:true,stdio:["ignore","pipe","pipe"]}).trim();
      let observed=false;
      // Exercise the actual native scenario's setup, then stop at its first UI
      // boundary. The branch switch below is real Git with the intentional edit.
      await assert.rejects(pullUpstreamSmoke({work,check:async(_,run)=>run(),page:{evaluate:async(_,root)=>{
        assert.equal(root,path.join(work,"pull-upstream-client"));observed=true;
        assert.equal(git(root,"config","--global","core.autocrlf"),${JSON.stringify(autocrlf)});
        assert.equal(git(root,"config","--local","core.autocrlf"),"false");
        const main=git(root,"rev-parse","main:file.txt"),feature=git(root,"rev-parse","HEAD:file.txt");
        assert.equal(feature,main,"feature must not commit a line-ending-only change");
        assert.equal(execFileSync("git",["-C",root,"show","HEAD:file.txt"],{encoding:"utf8",windowsHide:true}),"base\\n");
        const head=git(root,"rev-parse","HEAD");
        git(root,"switch","main");
        assert.equal(fs.readFileSync(path.join(root,"file.txt"),"utf8"),"uncommitted user work\\n");
        git(root,"pull","--ff-only");
        assert.equal(git(root,"rev-parse","HEAD"),git(path.join(work,"pull-upstream-server"),"rev-parse","HEAD"));
        assert.equal(git(root,"rev-parse","feature/completed"),head);
        assert.equal(fs.readFileSync(path.join(root,"file.txt"),"utf8"),"uncommitted user work\\n");
        throw stop;
      }}}),error=>error===stop);
      assert.ok(observed,"fixture did not reach the browser boundary");
    `;
    try{
      execFileSync(process.execPath,["--input-type=module","--eval",script],{encoding:"utf8",windowsHide:true,env:{...process.env,GIT_CONFIG_GLOBAL:globalConfig,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_COUNT:"0",PULL_FIXTURE_WORK:work},stdio:["ignore","pipe","pipe"]});
    }finally{
      const resolved=fs.realpathSync(work),parent=fs.realpathSync(base);
      assert.ok(resolved.startsWith(parent+path.sep)&&!fs.lstatSync(work).isSymbolicLink());
      fs.rmSync(work,{recursive:true,force:true});
    }
  });
}
