import {expect,it} from "vitest";
import {tokenProvider} from "./tokenProvider";
import type {ForgeConnections,ForgeInfo} from "./types";

function remote(host:string,kind:ForgeInfo["kind"]|null,api=""):ForgeConnections["remotes"][number]{
  return {host,name:"origin",project:"team/repo",isSsh:false,allowSshAlias:false,accountId:null,fingerprint:"reviewed-remote",error:null,
    forge:kind?{kind,host,api,webUrl:`https://${host}/team/repo`,project:"team/repo",remote:"origin",connectionRevision:null,accountLogin:null}:null};
}
it("preselects Bitbucket Cloud even before API credentials are available",()=>{
  expect(tokenProvider(remote("bitbucket.org",null))).toEqual({kind:"bitbucket",server:"https://bitbucket.org"});
});
it("keeps enterprise and installation prefixes while removing API endpoints",()=>{
  expect(tokenProvider(remote("gitlab.company.test","gitlab","https://gitlab.company.test/tools/api/v4"))).toEqual({kind:"gitlab",server:"https://gitlab.company.test/tools"});
  expect(tokenProvider(remote("github.company.test","github","https://github.company.test/api/v3"))).toEqual({kind:"github",server:"https://github.company.test"});
  expect(tokenProvider(remote("github.com","github","https://api.github.com"))).toEqual({kind:"github",server:"https://github.com"});
  expect(tokenProvider(remote("ssh.dev.azure.com","azure","https://dev.azure.com/company"))).toEqual({kind:"azure",server:"https://dev.azure.com/company"});
});
it("does not mistake Bitbucket Server or unknown remotes for supported Cloud accounts",()=>{
  expect(tokenProvider(remote("bitbucket.company.test","bitbucket-server","https://bitbucket.company.test"))).toBeNull();
  expect(tokenProvider(undefined)).toBeNull();
  expect(tokenProvider(remote("unknown.test",null))).toBeNull();
});
