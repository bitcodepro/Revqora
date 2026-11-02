import test from "node:test";
import assert from "node:assert/strict";
import {fillWorktreeFolder,assertWorktreeFolder} from "./worktree-manager-fixture.mjs";

test("worktree destination waits for the exact suggestion, fills once, and verifies the result",async()=>{
 const calls=[];let release;const completed=new Promise(resolve=>release=resolve);let value="old suggestion";
 const dialog={getByRole:(role,options)=>{assert.equal(role,"textbox");assert.deepEqual(options,{name:"Worktree folder",exact:true});return {fill:async expected=>{calls.push(["fill",expected]);value=expected;},inputValue:async()=>{calls.push(["read"]);return value;}};}};
 const page={waitForFunction:async(fn,expected)=>{
  calls.push(["wait",expected]);const previous=globalThis.document;
  try{
   globalThis.document={querySelector:selector=>{assert.equal(selector,'input[aria-label="Worktree folder"]');return {value};}};
   assert.equal(fn(expected),false);await completed;value=expected;assert.equal(fn(expected),true);
  }finally{globalThis.document=previous;}
 }};
 const filling=fillWorktreeFolder(page,dialog,"D:/fixture/main-topic","D:\\fixture\\chosen");
 await Promise.resolve();assert.deepEqual(calls,[["wait","D:/fixture/main-topic"]]);release();await filling;
 assert.deepEqual(calls,[["wait","D:/fixture/main-topic"],["fill","D:\\fixture\\chosen"],["read"]]);
});

test("concatenated or redirected worktree input fails before the caller can request a review",async()=>{
 for(const actual of ["D:/suggestedD:/chosen","D:/other",""]){
  let reviewed=false;
  const dialog={getByRole:()=>({fill:async()=>{},inputValue:async()=>actual})};
  await assert.rejects(async()=>{await fillWorktreeFolder({waitForFunction:async()=>{}},dialog,"D:/suggested","D:/chosen");reviewed=true;},/Worktree folder mismatch before review/);
  assert.equal(reviewed,false);
 }
 await assert.rejects(assertWorktreeFolder({getByRole:()=>({inputValue:async()=>"D:/suggestedD:/chosen"})},"D:/chosen"),/no review was requested/);
});

test("missing autofill fails without typing a destination or requesting a review",async()=>{
 const failure=new Error("suggested folder never appeared");let fills=0;
 await assert.rejects(fillWorktreeFolder({waitForFunction:async()=>{throw failure;}},{getByRole:()=>({fill:async()=>fills++})},"D:/suggested","D:/chosen"),e=>e===failure);
 assert.equal(fills,0);
});
