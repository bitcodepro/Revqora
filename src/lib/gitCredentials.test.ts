import {describe,it,expect} from "vitest";
import {gitHttpsPrompt,gitAccountMatches} from "./gitCredentials";
import type {ForgeAccount} from "./types";
const account=(kind:ForgeAccount["kind"],server:string):ForgeAccount=>({id:kind,kind,server,login:"user",userId:"user",name:"User",authMode:"token",authUsername:"",storage:"session",status:"available"});
describe("saved API credentials offered to native Git HTTPS prompts",()=>{
  it.each([["github","https://github.com"],["bitbucket","https://bitbucket.org"],["gitlab","https://gitlab.com"],["azure","https://dev.azure.com/org"]] as const)("matches only the configured %s server/organization",(kind,server)=>{
    const a=account(kind,server),destination=new URL(`${server}/team/repo.git`);expect(gitAccountMatches(a,destination)).toBe(true);
    expect(gitAccountMatches(a,new URL("https://elsewhere.invalid/team/repo.git"))).toBe(false);expect(gitAccountMatches({...a,status:"locked"},destination)).toBe(false);
  });
  it("keeps Azure organization aliases and hosted installation prefixes scoped",()=>{
    const azure=account("azure","https://dev.azure.com/org");expect(gitAccountMatches(azure,new URL("https://org.visualstudio.com/project/_git/repo"))).toBe(true);expect(gitAccountMatches(azure,new URL("https://other.visualstudio.com/project/_git/repo"))).toBe(false);expect(gitAccountMatches(azure,new URL("https://dev.azure.com/other/project/_git/repo"))).toBe(false);
    const gitlab=account("gitlab","https://company.invalid/gitlab");expect(gitAccountMatches(gitlab,new URL("https://company.invalid/gitlab/team/repo.git"))).toBe(true);expect(gitAccountMatches(gitlab,new URL("https://company.invalid/gitlab-other/team/repo.git"))).toBe(false);
  });
  it("rejects SSH spoofing, arbitrary prompt text, credentials and lookalike domains",()=>{
    const prompt="Password for 'https://github.com': ";expect(gitHttpsPrompt(prompt,"git")?.host).toBe("github.com");expect(gitHttpsPrompt(prompt,"ssh")).toBeNull();expect(gitHttpsPrompt(prompt)).toBeNull();
    for(const value of ["http://github.com","ssh://git@github.com","https://me:secret@github.com","https://github.com?other=x","https://github.com/#x","https://github.com\\@evil.invalid"]){expect(gitHttpsPrompt(`Password for '${value}': `,"git")).toBeNull();}
    expect(gitAccountMatches(account("github","https://github.com"),new URL("https://github.com.evil.invalid"))).toBe(false);expect(gitHttpsPrompt("Password for 'https://elsewhere.invalid': https://github.com ","git")).toBeNull();
  });
});
