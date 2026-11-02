import type { WorkflowDefinition, WorkflowStep } from "./types";

export const workflowKinds: Record<WorkflowStep["kind"], string> = {
  prAgent:"Agent: address PR feedback", prChecks:"Wait for PR CI", prRequestReview:"Request GitHub review", prMerge:"Merge pull request", prCleanup:"Clean up merged PR source", commit:"Stage and commit edits",
  checkClean: "Require clean files", checkBranch: "Require branch", branch: "Create and check out branch",
  cherryPick: "Cherry-pick commits", command: "Run test / build command", publish: "Publish branch", pr: "Create pull request",
};
export function workflowStep(kind: WorkflowStep["kind"]): WorkflowStep {
  return {kind,label:"",value:kind==="branch"?"${branch}":kind==="publish"?"origin":"",extra:kind==="branch"||kind==="pr"?"${base}":kind==="publish"?"${branch}":"",body:kind==="prCleanup"?JSON.stringify({local:true,remote:false,force:false,protectionRules:["main","master","develop","release/*"],reviewToken:""}):"",timeoutSeconds:300,when:"always",onFalse:"stop"};
}
export function newWorkflow(): WorkflowDefinition {
  return {id:"",name:"New workflow",steps:[workflowStep("checkClean"),workflowStep("branch"),workflowStep("command"),workflowStep("publish"),workflowStep("pr")]};
}
export function moveWorkflowStep(steps:WorkflowStep[],index:number,direction:-1|1):WorkflowStep[] {
  const to=index+direction;if(index<0||index>=steps.length||to<0||to>=steps.length)return steps;
  const next=[...steps];[next[index],next[to]]=[next[to],next[index]];return next;
}
export const workflowActive=(phase:string)=>["ready","running","stopping","interrupted","external","uncertain"].includes(phase);
export const workflowUnknown=(phase:string)=>["interrupted","external","uncertain"].includes(phase);
