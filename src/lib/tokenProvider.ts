import type { ForgeAccountKind, ForgeConnections } from "./types";

export function tokenProvider(remote: ForgeConnections["remotes"][number] | undefined): {kind:ForgeAccountKind;server:string}|null {
  const forge=remote?.forge;
  if(remote?.host==="bitbucket.org")return {kind:"bitbucket",server:"https://bitbucket.org"};
  if(!forge||forge.kind==="bitbucket-server")return null;
  if(forge.kind==="azure")return {kind:"azure",server:forge.api};
  if(forge.kind==="github")return {kind:"github",server:forge.api==="https://api.github.com"?"https://github.com":forge.api.replace(/\/api\/v3\/?$/,"")};
  if(forge.kind==="gitlab")return {kind:"gitlab",server:forge.api.replace(/\/api\/v4\/?$/,"")};
  return null;
}
