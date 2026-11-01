import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTimings, SMOKE_SUITES, assertSmokeCoverage } from "./ci-timing.mjs";

test("failed native scenarios retain partial timings and propagate the original error", async()=>{
  const base=process.env.REVQORA_TEST_TMP||os.tmpdir();fs.mkdirSync(base,{recursive:true});
  const work=fs.mkdtempSync(path.join(base,"ci-timing-test-")),file=path.join(work,"results.json");let clock=0;
  try{
    const timing=createTimings({file,summary:null,now:()=>clock}),failure=new Error("exact SHA mismatch");
    assert.equal(timing.measureSync("process","git",()=>{clock+=12;return "exact result";}),"exact result");
    await assert.rejects(timing.measure("scenario","84. remote-only preflight",async()=>{clock+=30;throw failure;}),e=>e===failure);
    const saved=JSON.parse(fs.readFileSync(file,"utf8"));
    assert.equal(saved.entries[0].status,"failed");assert.equal(saved.entries[0].ms,30);
    assert.equal(saved.totals["process: git"].ms,12);assert.equal(saved.elapsedMs,42);
    // A later pass must not overwrite the earlier failure, even before finish().
    await timing.measure("scenario","85. stale local guard",async()=>{clock+=5;return true;});
    assert.deepEqual(JSON.parse(fs.readFileSync(file,"utf8")).entries.map(e=>e.status),["failed","passed"]);
  }finally{fs.rmSync(work,{recursive:true,force:true});}
});

test("native partitions require all 133 scenarios including the previous 128 with no gap or overlap",()=>{
  let next=0;
  for(const [suite,{offset,count}] of Object.entries(SMOKE_SUITES)){
    assert.equal(offset,next);next+=count;
    assertSmokeCoverage(suite,count);
    assert.throws(()=>assertSmokeCoverage(suite,count-1),/Incomplete/);
    assert.throws(()=>assertSmokeCoverage(suite,count+1),/Incomplete/);
  }
  assert.equal(next,133);assertSmokeCoverage("all",133);
  assert.throws(()=>assertSmokeCoverage("all",119),/Incomplete/);
  assert.throws(()=>assertSmokeCoverage("typo",0),/Incomplete/);
});
