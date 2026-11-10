import {describe,it,expect,vi} from "vitest";
import {authorOf,matchesPrAuthor,mergePrAuthors,restoreAuthorPreferences,authorScope,authorSelectionValue,authorPreferencesKey,loadAuthorPreferences,samePrAuthor} from "./prAuthors";
import type {PullRequest,ForgeInfo} from "./types";
const row=(id:string,login:string,name="Same display name")=>({authorId:id,authorLogin:login,author:name} as PullRequest);
describe("PR author selection",()=>{
  it("separates people with equal display names using provider IDs",()=>{const a=row("1","alice"),b=row("2","bob");const authors=mergePrAuthors([], [a,b,a]);expect(authors).toHaveLength(2);expect(matchesPrAuthor(a,authorOf(a))).toBe(true);expect(matchesPrAuthor(b,authorOf(a))).toBe(false);});
  it("supports exact configured usernames without needing profile access",()=>{const mine={key:"login:alice",label:"Alice",login:"alice"};expect(matchesPrAuthor(row("1","ALICE"),mine)).toBe(true);expect(matchesPrAuthor(row("2","alice-other"),mine)).toBe(false);});
  it("does not confuse saved author filters between API accounts",()=>{const forge={kind:"bitbucket",api:"https://api.bitbucket.org/2.0",project:"team/repo",accountLogin:"first"} as ForgeInfo;expect(authorScope(forge,null)).not.toBe(authorScope({...forge,accountLogin:"second"},null));});
  it("isolates anonymous token profiles sharing the same display login and stays stable across reconnects",()=>{const f={kind:"bitbucket",api:"https://api.bitbucket.org/2.0",project:"team/repo",accountLogin:"Bitbucket token",accountId:"profile-one",connectionRevision:"session-one"} as ForgeInfo;expect(authorScope(f,null)).not.toBe(authorScope({...f,accountId:"profile-two"},null));expect(authorScope(f,null)).toBe(authorScope({...f,connectionRevision:"session-two"},null));});
  it("bounds and sanitizes persisted author choices",()=>{expect(restoreAuthorPreferences({selection:"<invalid>",mine:{key:"id:1",label:"bad\nname",login:"alice"}})).toEqual({selection:"all",mine:null,chosen:null});expect(restoreAuthorPreferences({selection:"mine",mine:authorOf(row("1","alice"))}).mine?.key).toBe("id:1");});
  it("keeps the selected option valid when a discovered author becomes My author",()=>{const mine=authorOf(row("1","alice"));expect(authorSelectionValue({selection:mine.key,mine,chosen:mine},mine)).toBe("mine");});
  it("deduplicates the configured nickname against its discovered provider ID without joining distinct IDs",()=>{
    const mine={key:"login:alice",label:"alice",login:"alice"},known=authorOf(row("1","ALICE"));
    expect(samePrAuthor(known,mine)).toBe(true);
    expect(authorSelectionValue({selection:known.key,mine,chosen:known},mine)).toBe("mine");
    expect(samePrAuthor(known,authorOf(row("2","alice")))).toBe(false);
  });
  it("reuses the migrated author for the same API account across repositories",()=>{
    const storage=new Map<string,string>();
    vi.stubGlobal("localStorage",{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value)});
    try{
      const mine=authorOf(row("1","alice"));
      const forge={kind:"bitbucket",api:"https://api.bitbucket.org/2.0",project:"team/first",accountId:"account-one"} as ForgeInfo;
      const next={...forge,project:"team/second"},other={...next,accountId:"account-two"};
      const first=authorScope(forge);
      localStorage.setItem(authorPreferencesKey("/first",first),JSON.stringify({mine,selection:"mine"}));
      expect(loadAuthorPreferences("/first",first,forge).mine).toEqual(mine);
      expect(loadAuthorPreferences("/second",authorScope(next),next)).toEqual({mine,selection:"all",chosen:null});
      expect(loadAuthorPreferences("/second",authorScope(other),other).mine).toBeNull();
    }finally{vi.unstubAllGlobals();}
  });
});
