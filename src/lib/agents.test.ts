import { describe, expect, it } from "vitest";
import { agentActive, agentArgs, agentPresets } from "./agents";
describe("agent launch arguments",()=>{
  it("keeps paths and shell characters literal",()=>{expect(agentArgs('["C:\\\\a b\\\\cli.js","a; $(whoami)","line\\nline"]')).toEqual(["C:\\a b\\cli.js","a; $(whoami)","line\nline"]);});
  it("requires a bounded string array",()=>{for(const value of ['{}','[1]','[null]','["\\u0000"]',JSON.stringify(Array(65).fill("a")),JSON.stringify(["a".repeat(8193)])])expect(()=>agentArgs(value)).toThrow();});
  it("uses explicit noninteractive permission modes",()=>{expect(agentPresets.codex).toEqual(["exec","--sandbox","workspace-write","-"]);expect(agentPresets.claude).toContain("acceptEdits");expect(agentPresets.claude).not.toContain("--dangerously-skip-permissions");});
  it("does not let external or interrupted tasks appear finished",()=>{for(const phase of ["queued","running","stopping","external","interrupted"])expect(agentActive(phase)).toBe(true);for(const phase of ["completed","cancelled","failed","timed-out","abandoned"])expect(agentActive(phase)).toBe(false);});
});
