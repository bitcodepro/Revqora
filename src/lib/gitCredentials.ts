import type {ForgeAccount} from "./types";
export function gitHttpsPrompt(prompt:string,origin?:string):URL|null{
  if(origin!=="git")return null;const match=/^(Username|Password) for '([^'\r\n\\]+)': $/.exec(prompt);if(!match)return null;
  try{const url=new URL(match[2]);return url.protocol==="https:"&&!url.password&&!url.search&&!url.hash?url:null;}catch{return null;}
}
/** Display filtering only; native code independently verifies this same boundary. */
export function gitAccountMatches(account:ForgeAccount,destination:URL):boolean{
  if(account.status!=="available")return false;
  try{const base=new URL(account.server),prefix=base.pathname.replace(/^\/+|\/+$/g,"");
    if(account.kind==="azure"&&base.hostname==="dev.azure.com"&&!destination.port&&destination.hostname===`${prefix}.visualstudio.com`)return true;
    return destination.origin===base.origin&&(!prefix||destination.pathname.replace(/^\/+|\/+$/g,"")===prefix||destination.pathname.startsWith(`/${prefix}/`));
  }catch{return false;}
}
