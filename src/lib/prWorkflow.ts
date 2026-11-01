import type { WorkflowDefinition, WorkflowStep, WorkflowRun, WorkflowReview, PrCleanupInput } from "./types";
import { workflowStep } from "./workflows";
import { loadAgentProfile } from "./agents";

export interface PrWorkflowSeed { number: number; head: string; base: string; remote: string }
export interface WorkflowAgentSettings { provider: "codex"|"claude"|"custom"; executable: string; argsText: string; prompt: string; worktreePath: string }
export function workflowAgentSettings(body: string): WorkflowAgentSettings {
  const fallback: WorkflowAgentSettings = {provider:"codex", executable:"", argsText:'["exec","--sandbox","workspace-write","-"]', prompt:"Address actionable review feedback. Keep unrelated changes out of this task.", worktreePath:""};
  try {
    const value:unknown=JSON.parse(body);
    if(!value||typeof value!=="object"||Array.isArray(value))return fallback;
    const fields=value as Record<string,unknown>;
    return {
      provider:fields.provider==="claude"||fields.provider==="custom"?fields.provider:"codex",
      executable:typeof fields.executable==="string"?fields.executable:fallback.executable,
      argsText:typeof fields.argsText==="string"?fields.argsText:fallback.argsText,
      prompt:typeof fields.prompt==="string"?fields.prompt:fallback.prompt,
      worktreePath:typeof fields.worktreePath==="string"?fields.worktreePath:"",
    };
  } catch { return fallback; }
}
export const automaticCheck = (kind: WorkflowStep["kind"]) => ["checkClean","checkBranch","command","prChecks"].includes(kind);
export function workflowCleanupSettings(body:string):PrCleanupInput {
 const fallback:PrCleanupInput={local:true,remote:false,force:false,protectionRules:["main","master","develop","release/*"],reviewToken:""};
 try {
  const value:unknown=JSON.parse(body);
  if(!value||typeof value!=="object"||Array.isArray(value))return fallback;
  const fields=value as Record<string,unknown>;
  return {local:fields.local===true,remote:fields.remote===true,force:fields.force===true,protectionRules:Array.isArray(fields.protectionRules)&&fields.protectionRules.every(r=>typeof r==="string")?fields.protectionRules:fallback.protectionRules,reviewToken:""};
 }catch{return fallback;}
}
export const automaticConsentKey = (run:WorkflowRun) => JSON.stringify([run.id,run.repository,run.workspace??null,run.definition,run.parameters]);
export function automaticReviewMatches(run:WorkflowRun,proof:WorkflowReview):boolean {
 const expected=run.definition.steps[run.cursor];
 if(!expected||!automaticCheck(expected.kind)||proof.step.kind!==expected.kind||proof.runId!==run.id||proof.cursor!==run.cursor||proof.workingDirectory!==(run.workspace??run.repository))return false;
 const expand=(s:string)=>s==="${branch}"?run.parameters.branch:s==="${base}"?run.parameters.base:s;
 return (Object.keys(expected) as (keyof WorkflowStep)[]).every(k=>proof.step[k]===(k==="extra"||k==="value"&&expected.kind==="checkBranch"?expand(String(expected[k])):expected[k]));
}
export function cleanupCoversRules(step:WorkflowStep,rules:string[]):boolean {
  if(step.kind!=="prCleanup")return true;
  try{const value=JSON.parse(step.body);return Array.isArray(value.protectionRules)&&rules.every(r=>value.protectionRules.includes(r));}catch{return false;}
}
export function prWorkflow(root: string, seed?: PrWorkflowSeed): WorkflowDefinition {
  const profile = loadAgentProfile(root), agent = {...workflowAgentSettings(""), ...profile, argsText:JSON.stringify(profile.args)};
  const step=(kind:WorkflowStep["kind"], value="", extra="", body=""):WorkflowStep=>({...workflowStep(kind),value,extra,body});
  return {id:"",name:`PR ${seed?`#${seed.number} `:""}follow-up`,steps:[
    step("prAgent",String(seed?.number??1),"",JSON.stringify({provider:agent.provider,executable:agent.executable,argsText:agent.argsText,prompt:agent.prompt,worktreePath:""})),
    step("command"), step("commit","fix: address review feedback"),
    step("publish",seed?.remote??"origin",seed?.head??"${branch}"),
    {...step("prChecks",String(seed?.number??1)),timeoutSeconds:1800},
    step("prRequestReview",String(seed?.number??1)),
    step("prMerge",String(seed?.number??1),"squash"),
  ]};
}
