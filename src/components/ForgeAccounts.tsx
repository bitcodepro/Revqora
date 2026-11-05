import {useCallback,useEffect,useRef,useState} from "react";
import {KeyRound,Lock,RefreshCw,UserRound} from "lucide-react";
import {api,errorMessage} from "../lib/api";
import {showDialog,toast} from "../lib/ui";
import type {ForgeAccount,ForgeAccountInput,ForgeAccountsSnapshot,ForgeConnections,ForgeAccountKind} from "../lib/types";
import {Modal} from "./Modal";
import {confirmDialog} from "./dialogs";
import {tokenProvider} from "../lib/tokenProvider";

const providers:Record<ForgeAccountKind,string>={github:"GitHub",gitlab:"GitLab",azure:"Azure DevOps",bitbucket:"Bitbucket Cloud"};
const defaults:Record<ForgeAccountKind,string>={github:"https://github.com",gitlab:"https://gitlab.com",azure:"https://dev.azure.com/organization",bitbucket:"https://bitbucket.org"};
const changed=()=>window.dispatchEvent(new CustomEvent("revqora:forge-accounts"));
export const forgeAccountsDialog=(root:string|null=null)=>showDialog<void>(close=><ForgeAccounts root={root} close={()=>close()}/>);

function ForgeAccounts({root,close}:{root:string|null;close:()=>void}){
  const [data,setData]=useState<ForgeAccountsSnapshot|null>(null),[connections,setConnections]=useState<ForgeConnections|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const [form,setForm]=useState(false),[editing,setEditing]=useState<ForgeAccount|null>(null),[kind,setKind]=useState<ForgeAccountKind>("github"),[server,setServer]=useState(defaults.github),[username,setUsername]=useState(""),[token,setToken]=useState(""),[authMode,setAuthMode]=useState("token"),[persist,setPersist]=useState(false);
  const [readProfile,setReadProfile]=useState(false),[useGit,setUseGit]=useState(false);
  const [password,setPassword]=useState(""),[confirmation,setConfirmation]=useState(""),[changePassword,setChangePassword]=useState(false),[remote,setRemote]=useState(""),[account,setAccount]=useState(""),[allowAlias,setAllowAlias]=useState(false),[connect,setConnect]=useState(true);
  const active=useRef(false),generation=useRef(0);
  const refresh=useCallback(async()=>{const id=++generation.current;setLoading(true);try{
    const [d,c]=await Promise.all([api.forgeAccounts(),root?api.forgeConnections(root):Promise.resolve(null)]);
    if(id!==generation.current)return;setData(d);setConnections(c);setRemote(old=>c?.remotes.some(r=>r.name===old)?old:c?.activeRemote??"");
  }catch(e){if(id===generation.current)setError(errorMessage(e));}finally{if(id===generation.current)setLoading(false);}},[root]);
  useEffect(()=>{void refresh();return()=>{generation.current++;};},[refresh]);
  useEffect(()=>{const r=connections?.remotes.find(r=>r.name===remote);setAccount(r?.accountId??"");setAllowAlias(r?.allowSshAlias??false);if(!r)setUseGit(false);},[remote,connections]);
  const perform=async(fn:()=>Promise<unknown>,success?:string)=>{if(active.current||loading)return;active.current=true;setBusy(true);setError("");
    try{await fn();changed();if(success)toast.success(success);await refresh();return true;}catch(e){setError(errorMessage(e));await refresh();return false;}
    finally{setToken("");setPassword("");setConfirmation("");active.current=false;setBusy(false);}
  };
  const begin=(p:ForgeAccount|null)=>{const preset=tokenProvider(connections?.remotes.find(r=>r.name===remote));const provider=p?.kind??preset?.kind??"github";setEditing(p);setKind(provider);setServer(p?.server??preset?.server??defaults[provider]);setUsername(p?.authUsername??"");setAuthMode(p?.authMode??(provider==="bitbucket"?"basic":"token"));setPersist(p?.storage==="encrypted"&&!!data?.vaultUnlocked);setReadProfile(!!p&&p.identityVerified!==false);setUseGit(false);setConnect(true);setToken("");setError("");setForm(true);};
  const save=async()=>{if(!data||(!token&&!useGit)||active.current)return;const input:ForgeAccountInput={id:editing?.id??null,kind,server,username,token:useGit?"":token,authMode,persist,verifyIdentity:kind!=="bitbucket"||readProfile,...(useGit&&root&&target?{gitSource:{repo:root,remote:target.name,fingerprint:target.fingerprint}}:{})};
    await perform(async()=>{
      const saved=await api.forgeAccountAdd(input,data.revision);
      // Once saved, a failed/stale repository binding must not resubmit the token.
      setForm(false);setEditing(null);
      const added=editing?saved.accounts.find(a=>a.id===editing.id):saved.accounts.find(a=>!data.accounts.some(old=>old.id===a.id));
      if(connect&&!editing&&root&&target&&connections&&added){
        try{await api.forgeConnectionSelect(root,{remote:target.name,fingerprint:target.fingerprint,accountId:added.id,allowSshAlias:false},saved.revision);}
        catch(e){throw new Error(`Account saved. Repository connection was not changed: ${errorMessage(e)} Select it below and click Use for PR and checks.`);}
      }
    },kind==="bitbucket"&&!readProfile?"Bitbucket token connected without reading your profile":"API account verified");
  };
  const vaultAction=async()=>{if(!data)return;const unlock=data.vaultConfigured&&!data.vaultUnlocked;if(!unlock&&password!==confirmation){setError("The vault passwords do not match.");return;}
    if(await perform(()=>api.forgeVaultPassword(password,data.revision,unlock),unlock?"Vault unlocked":"Vault password saved"))setChangePassword(false);
  };
  const target=connections?.remotes.find(r=>r.name===remote),disabled=busy||loading;
  const chosen=data?.accounts.find(p=>p.id===account),alias=!!target?.isSsh&&!!chosen&&chosen.kind!=="azure"&&target.host!==new URL(chosen.server).hostname;
  const remove=async(p:ForgeAccount)=>{if(!data)return;const expected=data.revision;
    if(await confirmDialog({title:`Remove ${p.login}?`,message:"Removes this account and its saved token from Revqora. The server token is not revoked. Repository connections will require an explicit new selection.",confirm:"Remove account",danger:true}))await perform(()=>api.forgeAccountRemove(p.id,expected),"API account removed");
  };
  const reset=async()=>{if(!data)return;const expected=data.revision;if(await confirmDialog({title:"Forget saved API tokens?",message:"Deletes encrypted tokens and the vault password setup. Account metadata and repository selections stay, so you can reconnect explicitly. Active session tokens are also cleared.",confirm:"Forget tokens",danger:true}))await perform(()=>api.forgeVaultReset(expected),"Saved tokens forgotten");};
  return <Modal title="Accounts and API connections" icon={<UserRound size={18}/>} subtitle="Git and PRs reuse matching HTTPS credentials. API connections let you select a token explicitly or save it in the portable vault. Commit author identity is configured separately." wide onClose={()=>{if(!active.current)close();}} onSubmit={()=>{if(password)void vaultAction();else if(form&&(token||useGit))void save();}} footer={<button type="button" className="btn primary" disabled={busy} onClick={close}>Close</button>}>
    <div className="fa-workspace" aria-busy={disabled}>
      <div className="hstack"><b>API accounts</b><div className="spacer"/><button className="btn" type="button" disabled={disabled} onClick={()=>begin(null)}>Add API account</button><button className="icon-btn" type="button" aria-label="Refresh API accounts" disabled={disabled} onClick={()=>{setError("");void refresh();}}><RefreshCw size={15}/></button></div>
      <p className="help">Have a token? Click <b>Add API account</b>, choose its provider and paste it below. No browser sign-in is required. Existing Git credential-manager credentials are still used automatically; new Git sign-ins stay in Revqora.</p>
      {loading&&<p role="status">Loading account settings…</p>}
      {error&&<p className="fa-error" role="alert">{error}</p>}
      <div className="fa-accounts">{data?.accounts.map(p=><section className="fa-card" key={p.id} data-account-id={p.id}>
        <div><b>{p.login}</b><span className="pill">{providers[p.kind]}</span><span className="pill">{p.status==="available"?"Ready":p.status==="locked"?"Locked":"Reconnect"}</span>{p.identityVerified===false&&<span className="pill">Profile not read</span>}</div>
        <small>{p.name}</small><code>{p.server}</code><small>{p.storage==="encrypted"?"Encrypted token beside the executable":"Session token · reconnect after restarting or locking"}</small>
        <div className="hstack"><button className="btn sm" type="button" disabled={disabled} onClick={()=>begin(p)}>Reconnect</button><button className="btn sm" type="button" disabled={disabled||p.status!=="available"||p.identityVerified===false&&(!root||target?.accountId!==p.id)} title={p.identityVerified===false?"Tests PR access through this repository's selected token connection":"Test API account"} onClick={()=>void perform(()=>api.forgeAccountTest(p.id,p.identityVerified===false?root:null),"Account connection verified")}>Test connection</button><button className="btn sm danger" type="button" disabled={disabled} onClick={()=>void remove(p)}>Remove</button></div>
      </section>)}{data&&!data.accounts.length&&<p className="muted">Add a token to choose a specific API identity, or use existing Git credentials for a repository remote.</p>}</div>
      {form&&<fieldset className="fa-form" disabled={disabled}><b>{editing?`Reconnect ${editing.login}`:"Add an API account"}</b>
        <label className="field">Provider<select className="select" aria-label="API provider" disabled={!!editing} value={kind} onChange={e=>{const k=e.target.value as ForgeAccountKind;setKind(k);setServer(defaults[k]);setAuthMode(k==="bitbucket"?"basic":"token");setReadProfile(false);setUseGit(false);setToken("");setUsername("");}}>{Object.entries(providers).map(([k,v])=><option value={k} key={k}>{v}</option>)}</select></label>
        <label className="field">Server URL<input className="input mono" aria-label="API server URL" disabled={!!editing} value={server} onChange={e=>{setServer(e.target.value);setToken("");}}/></label>
        <small>Use the web server address, including a GitLab installation prefix or Azure organization. The API URL is derived from this address. Remote services require HTTPS; literal loopback IPs can use HTTP for local services.</small>
        {kind==="bitbucket"&&root&&target&&<label className="check"><input type="checkbox" aria-label="Use existing Git token" checked={useGit} onChange={e=>{setUseGit(e.target.checked);setToken("");}}/>Use the Git token already available for {target.name}</label>}
        {kind==="bitbucket"&&!useGit&&<><label className="field">Authentication<select className="select" aria-label="Bitbucket token type" value={authMode} onChange={e=>{setAuthMode(e.target.value);setToken("");}}><option value="basic">API token + Atlassian email</option><option value="bearer">Access token (Bearer)</option></select></label>{authMode==="basic"&&<label className="field">Atlassian email<input className="input" aria-label="Atlassian email" value={username} onChange={e=>setUsername(e.target.value)}/></label>}</>}
        {!useGit&&<label className="field">Access token<input className="input" type="password" aria-label="API access token" autoComplete="off" spellCheck={false} value={token} onChange={e=>setToken(e.target.value)}/></label>}
        {kind==="bitbucket"&&<><label className="check"><input type="checkbox" aria-label="Read Bitbucket profile" checked={readProfile} onChange={e=>setReadProfile(e.target.checked)}/>Read Bitbucket profile (optional)</label><small>Profile reading needs read:user:bitbucket. Leave it off to use only repository/PR scopes; Bitbucket checks which actions the token permits.</small>{useGit&&<p className="help">The existing Git credential is read natively, without another token entry. After clone/fetch/push, matching HTTPS credentials can be reused during this session. Use the encrypted vault to keep this connection after restarting.</p>}</>}
        <small>Token permissions determine access. GitHub may require organization SSO authorization; GitLab needs user/API access. Bitbucket profile access is optional.</small>
        {kind==="bitbucket"&&<p className="help">API tokens use your Atlassian email for PRs and checks. For HTTPS Fetch/Pull/Push, select this saved account in Revqora's Git sign-in dialog, or use <code>x-bitbucket-api-token-auth</code> as the Git username and your API token as the password. OAuth tokens use <code>x-token-auth</code>. SSH remotes continue to use SSH keys.</p>}
        {kind==="bitbucket"&&<p className="help">Repository/workspace access tokens can also connect with Bearer authentication and profile reading off. Repository and PR operations require their corresponding token permissions.</p>}
        {!editing&&target&&<label className="check"><input type="checkbox" aria-label="Use token for this repository" checked={connect} onChange={e=>setConnect(e.target.checked)}/>Use this account for {target.name} PRs and checks</label>}
        <label className="check"><input type="checkbox" aria-label="Save API token in encrypted vault" checked={persist} disabled={!data?.vaultUnlocked} onChange={e=>setPersist(e.target.checked)}/>Save token in the encrypted vault</label>{!data?.vaultUnlocked&&<small>Create or unlock the vault below to save a token. Otherwise it stays in memory for this session.</small>}
        <div className="hstack"><button className="btn primary" type="button" disabled={!token&&!useGit} onClick={()=>void save()}>{kind==="bitbucket"&&!readProfile?"Save token connection":"Verify and save account"}</button><button className="btn" type="button" onClick={()=>{setForm(false);setToken("");}}>Cancel account</button></div>
      </fieldset>}
      <section className="fa-vault"><div className="hstack"><KeyRound size={16}/><b>Portable token vault</b><span className="muted">{data?.vaultConfigured?data.vaultUnlocked?"Unlocked":"Locked":"Not configured"}</span></div>
        <p>Saved tokens are encrypted in <code>data/accounts</code> beside Revqora. Your vault password is required after restarting. Keep that password: forgetting it requires reconnecting saved accounts.</p>
        {data&&(!data.vaultConfigured||!data.vaultUnlocked||changePassword)&&<fieldset className="fa-form" disabled={disabled}>
          <label className="field">Vault password<input className="input" type="password" aria-label="Vault password" autoComplete={data.vaultConfigured&&!data.vaultUnlocked?"current-password":"new-password"} value={password} onChange={e=>setPassword(e.target.value)}/></label>
          {(!data.vaultConfigured||changePassword)&&<label className="field">Confirm vault password<input className="input" type="password" aria-label="Confirm vault password" autoComplete="new-password" value={confirmation} onChange={e=>setConfirmation(e.target.value)}/></label>}
          <button className="btn" type="button" disabled={!password} onClick={()=>void vaultAction()}>{data.vaultConfigured&&!data.vaultUnlocked?"Unlock vault":data.vaultConfigured?"Save new vault password":"Create vault"}</button>
        </fieldset>}
        <div className="hstack">{data?.vaultUnlocked&&<button className="btn" type="button" disabled={disabled} onClick={()=>setChangePassword(v=>!v)}>Change vault password</button>}{!!data?.accounts.length&&<button className="btn" type="button" disabled={disabled} onClick={()=>void perform(()=>api.forgeVaultLock(),"Saved tokens locked and sessions cleared")}><Lock size={14}/>Lock tokens and clear sessions</button>}{data?.vaultConfigured&&<button className="btn danger" type="button" disabled={disabled} onClick={()=>void reset()}>Forget saved tokens…</button>}</div>
      </section>
      {root&&<section className="fa-connections"><b>Repository API connection</b><code>{root}</code><p>Choose the remote used for PR and checks, then its API account. SSH remotes can use an API token independently of their SSH key. Changing a remote URL requires a new selection.</p>
        {connections?.remotes.length?<fieldset className="fa-form" disabled={disabled}>
          <label className="field">Remote<select className="select" aria-label="API remote" value={remote} onChange={e=>setRemote(e.target.value)}>{connections.remotes.map(r=><option key={r.name} value={r.name}>{r.name} · {r.host} / {r.project}</option>)}</select></label>
          {target?.error&&<p className="fa-error">{target.error}</p>}
          <label className="field">API account<select className="select" aria-label="Repository API account" value={account} onChange={e=>{setAccount(e.target.value);setAllowAlias(false);}}><option value="">Use Git credential helper</option>{data?.accounts.map(p=><option key={p.id} value={p.id} disabled={p.status!=="available"}>{providers[p.kind]} · {p.login} · {p.server}{p.status!=="available"?` · ${p.status}`:""}</option>)}{target?.accountId&&!data?.accounts.some(p=>p.id===target.accountId)&&<option value={target.accountId} disabled>Removed account — choose another</option>}</select></label>
          {alias&&<label className="check"><input type="checkbox" aria-label="Confirm SSH alias API mapping" checked={allowAlias} onChange={e=>setAllowAlias(e.target.checked)}/>Use the selected API server for this SSH host alias ({target?.host})</label>}
          <button className="btn primary" type="button" disabled={alias&&!allowAlias} onClick={()=>{if(target&&connections)void perform(()=>api.forgeConnectionSelect(root,{remote:target.name,fingerprint:target.fingerprint,accountId:account||null,allowSshAlias:allowAlias},connections.revision),"API account and remote selected");}}>Use for PR and checks</button>
        </fieldset>:<p className="muted">This repository has no remotes.</p>}
      </section>}
    </div>
  </Modal>;
}
