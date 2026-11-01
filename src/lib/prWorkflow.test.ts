import { describe, expect, it } from "vitest";
import { automaticCheck, automaticConsentKey, automaticReviewMatches, cleanupCoversRules, prWorkflow, workflowAgentSettings, workflowCleanupSettings } from "./prWorkflow";
import type { WorkflowRun, WorkflowReview } from "./types";
import { workflowStep } from "./workflows";
describe("PR workflow consent boundaries",()=>{
 it("cleanup fields preserve scope and never coerce text into deletion consent or reuse a review token",()=>{
  expect(workflowCleanupSettings(JSON.stringify({local:true,remote:false,force:"true",protectionRules:["custom/*"],reviewToken:"old"}))).toEqual({local:true,remote:false,force:false,protectionRules:["custom/*"],reviewToken:""});
  expect(workflowCleanupSettings("null").remote).toBe(false);
 });
 it("malformed saved agent fields cannot break the editor",()=>{
  expect(workflowAgentSettings('{"executable":null,"argsText":[],"prompt":42,"provider":"unknown"}')).toEqual(workflowAgentSettings(""));
  expect(workflowAgentSettings("null")).toEqual(workflowAgentSettings(""));
 });
 it("automatic consent freezes recipe, parameters and working copy; progress cannot broaden it",()=>{
  const run:WorkflowRun={id:"run",repository:"/source",workspace:"/copy",definition:{id:"recipe",name:"Checks",steps:[{...workflowStep("command"),value:"npm test"}]},parameters:{branch:"topic",base:"main"},phase:"ready",cursor:0,createdAt:1,results:[],error:null};
  const proof:WorkflowReview={workingDirectory:"/copy",runId:run.id,cursor:0,runRevision:"reviewed",stateToken:"state",branch:"topic",head:"head",step:{...run.definition.steps[0]},resolved:[],connection:"",remoteFingerprint:"",remoteHead:null,skip:false,conditionMet:true,consentRequired:true,explanation:""};
  expect(automaticReviewMatches(run,proof)).toBe(true);expect(automaticReviewMatches(run,{...proof,workingDirectory:"/other"})).toBe(false);expect(automaticReviewMatches(run,{...proof,step:{...proof.step,value:"npm publish"}})).toBe(false);expect(automaticReviewMatches(run,{...proof,step:{...proof.step,kind:"publish"}})).toBe(false);
  const key=automaticConsentKey(run);expect(automaticConsentKey({...run,phase:"running",cursor:1})).toBe(key);expect(automaticConsentKey({...run,workspace:"/other"})).not.toBe(key);expect(automaticConsentKey({...run,definition:{...run.definition,steps:[{...proof.step,value:"npm publish"}]}})).not.toBe(key);
 });
 it("cleanup cannot omit current custom protection patterns",()=>{
  const step=workflowStep("prCleanup");expect(cleanupCoversRules(step,["main"])).toBe(true);expect(cleanupCoversRules(step,["main","critical/*"])).toBe(false);
  step.body=JSON.stringify({protectionRules:["main","critical/*"]});expect(cleanupCoversRules(step,["main","critical/*"])).toBe(true);
  step.body="invalid";expect(cleanupCoversRules(step,[])).toBe(false);
 });
 it("only opts into checks and literal validations, never agent/Git/server writes",()=>{
  for(const kind of ["prAgent","commit","publish","pr","prRequestReview","prMerge","prCleanup","branch","cherryPick"] as const)expect(automaticCheck(kind)).toBe(false);
  for(const kind of ["checkClean","checkBranch","command","prChecks"] as const)expect(automaticCheck(kind)).toBe(true);
 });
 it("binds the follow-up recipe to the selected PR branch and requires explicit executable, tests and reviewer configuration",()=>{
  const recipe=prWorkflow("fixture",{number:7,head:"feature/auth",base:"main",remote:"upstream"});
  expect(recipe.steps.filter(s=>s.kind.startsWith("pr")).every(s=>s.value==="7")).toBe(true);
  expect(recipe.steps.find(s=>s.kind==="publish")).toMatchObject({value:"upstream",extra:"feature/auth"});
  expect(recipe.steps.find(s=>s.kind==="command")?.value).toBe("");
  expect(recipe.steps.find(s=>s.kind==="prRequestReview")?.extra).toBe("");
  expect(workflowAgentSettings(recipe.steps[0].body).executable).toBe("");
 });
});
