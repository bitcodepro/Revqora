import { describe, expect, it } from "vitest";
import { moveWorkflowStep, newWorkflow, workflowActive, workflowStep, workflowUnknown } from "./workflows";
describe("workflow recipes",()=>{
 it("starts with explicit safety checks and leaves commands empty for the user",()=>{
  const recipe=newWorkflow();expect(recipe.steps.map(s=>s.kind)).toEqual(["checkClean","branch","command","publish","pr"]);
  expect(recipe.steps[2].value).toBe("");expect(recipe.steps[1].value).toBe("${branch}");expect(recipe.steps[4].extra).toBe("${base}");
 });
 it("reorders whole steps without losing descriptions, conditions or command text",()=>{
  const command={...workflowStep("command"),value:'echo "${branch}"',when:"dirty" as const,onFalse:"skip" as const};
  const pr={...workflowStep("pr"),body:"Long description\n\nCo-authored-by: Example"};const steps=[command,pr];const reordered=moveWorkflowStep(steps,1,-1);
  expect(reordered).toEqual([pr,command]);expect(steps).toEqual([command,pr]);expect(moveWorkflowStep(steps,0,-1)).toBe(steps);expect(reordered[1].value).toBe('echo "${branch}"');
 });
 it("blocks new runs while results need acknowledgement and distinguishes terminal failures",()=>{
  for(const phase of ["ready","running","stopping","interrupted","external","uncertain"])expect(workflowActive(phase)).toBe(true);
  for(const phase of ["completed","failed","cancelled","abandoned"])expect(workflowActive(phase)).toBe(false);
  expect(workflowUnknown("uncertain")).toBe(true);expect(workflowUnknown("failed")).toBe(false);
 });
});
