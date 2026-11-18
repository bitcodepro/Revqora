import {useCallback,useEffect,useRef,useState} from "react";
import {ArrowLeft,ExternalLink,Eye,EyeOff,KeyRound,Lock,RefreshCw,UserRound} from "lucide-react";
import {api,errorMessage} from "../lib/api";
import {showDialog,toast} from "../lib/ui";
import type {ForgeAccount,ForgeAccountInput,ForgeAccountsSnapshot,ForgeConnections,ForgeAccountKind} from "../lib/types";
import {Modal} from "./Modal";
import {confirmDialog} from "./dialogs";
import {tokenProvider} from "../lib/tokenProvider";
import {connectionCheckDialog} from "./Diagnostics";
import {gitConnectionDialog} from "./GitConnections";
import {authModeOf,methodOf,missingInput,providerNames as providers,providerServers as defaults,signInMethods,tokenPage,type SignInMethodId} from "../lib/accountMethods";

const changed=()=>window.dispatchEvent(new CustomEvent("revqora:forge-accounts"));
const openLink=(url:string)=>void api.openPath(url).catch(e=>toast.error(e,"Could not open link"));
export const forgeAccountsDialog=(root:string|null=null)=>showDialog<void>(close=><ForgeAccounts root={root} close={()=>close()}/>);

function ForgeAccounts({root,close}:{root:string|null;close:()=>void}){
  const [data,setData]=useState<ForgeAccountsSnapshot|null>(null),[connections,setConnections]=useState<ForgeConnections|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const [form,setForm]=useState(false),[editing,setEditing]=useState<ForgeAccount|null>(null),[kind,setKind]=useState<ForgeAccountKind>("github"),[server,setServer]=useState(defaults.github),[username,setUsername]=useState(""),[token,setToken]=useState(""),[method,setMethod]=useState<SignInMethodId>("token"),[persist,setPersist]=useState(false);
  const [readProfile,setReadProfile]=useState(false),[editServer,setEditServer]=useState(false),[showToken,setShowToken]=useState(false);
  const [password,setPassword]=useState(""),[confirmation,setConfirmation]=useState(""),[changePassword,setChangePassword]=useState(false),[setupVault,setSetupVault]=useState(false),[remote,setRemote]=useState(""),[account,setAccount]=useState(""),[allowAlias,setAllowAlias]=useState(false),[connect,setConnect]=useState(true);
  const active=useRef(false),generation=useRef(0);
  const refresh=useCallback(async()=>{const id=++generation.current;setLoading(true);try{
    const [d,c]=await Promise.all([api.forgeAccounts(),root?api.forgeConnections(root):Promise.resolve(null)]);
    if(id!==generation.current)return;setData(d);setConnections(c);setRemote(old=>c?.remotes.some(r=>r.name===old)?old:c?.activeRemote??"");
  }catch(e){if(id===generation.current)setError(errorMessage(e));}finally{if(id===generation.current)setLoading(false);}},[root]);
  useEffect(()=>{void refresh();return()=>{generation.current++;};},[refresh]);
  // The Git-token method exists only while the selected remote does.
  useEffect(()=>{const r=connections?.remotes.find(r=>r.name===remote);setAccount(r?.accountId??"");setAllowAlias(r?.allowSshAlias??false);if(!r)setMethod(m=>m==="git"?"basic":m);},[remote,connections]);
  const perform=async(fn:()=>Promise<unknown>,success?:string)=>{if(active.current||loading)return;active.current=true;setBusy(true);setError("");
    try{await fn();changed();if(success)toast.success(success);await refresh();return true;}catch(e){setError(errorMessage(e));await refresh();return false;}
    finally{setToken("");setPassword("");setConfirmation("");active.current=false;setBusy(false);}
  };
  const target=connections?.remotes.find(r=>r.name===remote),disabled=busy||loading;
  // A Bitbucket remote's Git token can be reused instead of pasting one.
  const gitRemote=kind==="bitbucket"&&root&&target?target.name:null;
  const methods=signInMethods(kind,gitRemote),chosenMethod=methods.find(m=>m.id===method)??methods[0],useGit=chosenMethod.id==="git";
  const authMode=authModeOf(kind,chosenMethod.id,username);
  const missing=missingInput(kind,chosenMethod.id,{server,email:username,token});
  const begin=(p:ForgeAccount|null)=>{const preset=tokenProvider(connections?.remotes.find(r=>r.name===remote));const provider=p?.kind??preset?.kind??"github";setEditing(p);setKind(provider);setServer(p?.server??preset?.server??defaults[provider]);setUsername(p?.authUsername??"");setMethod(methodOf(provider,p?.authMode));setPersist(p?.storage==="encrypted"&&!!data?.vaultUnlocked);setReadProfile(!!p&&p.identityVerified!==false);setConnect(true);setToken("");setShowToken(false);setEditServer(false);setPassword("");setConfirmation("");setError("");setForm(true);};
  const chooseProvider=(k:ForgeAccountKind)=>{if(k===kind)return;setKind(k);setServer(defaults[k]);setEditServer(false);setMethod(signInMethods(k)[0].id);setReadProfile(false);setToken("");setUsername("");};
  const cancelForm=()=>{setForm(false);setEditing(null);setToken("");};
  const save=async()=>{if(!data||missing||active.current)return;const input:ForgeAccountInput={id:editing?.id??null,kind,server,username,token:useGit?"":token,authMode,persist,verifyIdentity:kind!=="bitbucket"||readProfile,...(useGit&&root&&target?{gitSource:{repo:root,remote:target.name,fingerprint:target.fingerprint}}:{})};
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
    if(await perform(()=>api.forgeVaultPassword(password,data.revision,unlock),unlock?"Vault unlocked":"Vault password saved")){setChangePassword(false);setSetupVault(false);}
  };
  const chosen=data?.accounts.find(p=>p.id===account),alias=!!target?.isSsh&&!!chosen&&chosen.kind!=="azure"&&target.host!==new URL(chosen.server).hostname;
  const activeRemote=connections?.remotes.find(r=>r.name===connections.activeRemote);
  const activeAccount=data?.accounts.find(p=>p.id===activeRemote?.accountId);
  const connectionLabel=activeRemote?.accountId ? activeAccount?.login ?? "Removed API account" : "Git credentials (automatic)";
  const remove=async(p:ForgeAccount)=>{if(!data)return;const expected=data.revision;
    if(await confirmDialog({title:`Remove ${p.login}?`,message:"Removes this account and its saved token from Revqora. The server token is not revoked. Repository connections will require an explicit new selection.",confirm:"Remove account",danger:true}))await perform(()=>api.forgeAccountRemove(p.id,expected),"API account removed");
  };
  const reset=async()=>{if(!data)return;const expected=data.revision;if(await confirmDialog({title:"Forget saved API tokens?",message:"Deletes encrypted tokens and the vault password setup. Account metadata and repository selections stay, so you can reconnect explicitly. Active session tokens are also cleared.",confirm:"Forget tokens",danger:true}))await perform(()=>api.forgeVaultReset(expected),"Saved tokens forgotten");};
  const vaultFields=!!data&&(data.vaultConfigured&&!data.vaultUnlocked||changePassword||!data.vaultConfigured&&setupVault);
  const page=tokenPage(kind,chosenMethod.id,server),serverField=editServer||kind==="azure"||!server.trim();
  return <Modal title="Accounts and API connections" icon={<UserRound size={18}/>} subtitle="Choose how Revqora signs in for pull requests and Git operations." wide onClose={()=>{if(!active.current)close();}} onSubmit={()=>{if(password)void vaultAction();else if(form&&!missing)void save();}} footer={<button type="button" className="btn primary" disabled={busy} onClick={close}>Close</button>}>
    <div className="fa-workspace" aria-busy={disabled}>
      {loading&&<p role="status">Loading account settings…</p>}
      {error&&<p className="fa-error" role="alert">{error}</p>}
      {form?<fieldset className="fa-form fa-add" disabled={disabled}>
        <div className="hstack"><button type="button" className="icon-btn" aria-label="Back to accounts" title="Back to accounts" onClick={cancelForm}><ArrowLeft size={15}/></button><b>{editing?`Reconnect ${editing.login}`:"Add an API account"}</b></div>
        <p className="fa-lead">{editing?"Enter a new token for this account. The service and server stay the same.":"Pick the service, then one way to sign in. You only fill in the fields of the method you choose."}</p>

        <section className="fa-step" aria-label="Service">
          <span className="fa-step-title"><span className="fa-num">1</span>Service</span>
          {editing?<p className="fa-summary">{providers[kind]} · <code>{server}</code></p>:<>
            <div className="seg fa-providers" role="radiogroup" aria-label="API provider">{(Object.keys(providers) as ForgeAccountKind[]).map(k=><button type="button" role="radio" key={k} aria-checked={kind===k} className={kind===k?"on":""} onClick={()=>chooseProvider(k)}>{providers[k]}</button>)}</div>
            {serverField?<label className="field"><span>{kind==="azure"?"Organization URL":"Server URL"} <span className="fa-req">required</span></span><input className="input mono" aria-label="API server URL" placeholder={kind==="azure"?"https://dev.azure.com/your-organization":defaults[kind]} value={server} onChange={e=>{setServer(e.target.value);setToken("");}}/>
              <small>{kind==="azure"?"Your organization address, for example https://dev.azure.com/contoso.":"The web address of the server, including a GitLab installation prefix. Remote services require HTTPS; literal loopback IPs can use HTTP for local services."}</small></label>
            :<p className="fa-summary">Server <code>{server}</code> <button type="button" className="btn sm ghost" onClick={()=>setEditServer(true)}>Change server</button></p>}
          </>}
        </section>

        <section className="fa-step" aria-label="Sign-in method">
          <span className="fa-step-title"><span className="fa-num">2</span>How do you sign in?</span>
          {methods.length>1?<div className="radio-cards" role="radiogroup" aria-label="Sign-in method">{methods.map(m=><label key={m.id} className={`radio-card ${chosenMethod.id===m.id?"on":""}`}>
            <input type="radio" name="fa-method" aria-label={m.title} checked={chosenMethod.id===m.id} onChange={()=>{setMethod(m.id);setToken("");}}/>
            <div><div className="rt">{m.title}</div><div className="rd">{m.description}</div></div></label>)}</div>
          :<p className="fa-summary"><b>{chosenMethod.title}</b> — {chosenMethod.description}</p>}
        </section>

        <section className="fa-step" aria-label="Sign-in details">
          <span className="fa-step-title"><span className="fa-num">3</span>{useGit?"Optional details":"Enter the details"}</span>
          {chosenMethod.fields.includes("email")&&<label className="field"><span>Atlassian email <span className="fa-req">required</span></span><input className="input" type="email" aria-label="Atlassian email" autoComplete="email" required value={username} onChange={e=>setUsername(e.target.value)}/></label>}
          {chosenMethod.fields.includes("optionalEmail")&&<label className="field"><span>Atlassian email <span className="fa-opt">optional</span></span><input className="input" type="email" aria-label="Atlassian email" autoComplete="email" value={username} onChange={e=>setUsername(e.target.value)}/>
            <small>Enter it if the Git token is an Atlassian API token. Leave it empty for an access token. The existing Git credential is read natively, without another token entry; it lasts for this session unless you keep it in the vault.</small></label>}
          {chosenMethod.fields.includes("token")&&<label className="field"><span>{chosenMethod.tokenLabel??"Access token"} <span className="fa-req">required</span></span>
            <div className="fa-secret"><input className="input" type={showToken?"text":"password"} aria-label="API access token" autoComplete="off" spellCheck={false} value={token} onChange={e=>setToken(e.target.value)}/>
              <button type="button" className="icon-btn sm" aria-label={showToken?"Hide token":"Show token"} title={showToken?"Hide token":"Show token"} onClick={()=>setShowToken(s=>!s)}>{showToken?<EyeOff size={14}/>:<Eye size={14}/>}</button></div>
            {(chosenMethod.permissions||page)&&<small>{chosenMethod.permissions} {page&&<button type="button" className="btn sm ghost" onClick={()=>openLink(page)}>Create a token <ExternalLink size={12}/></button>}</small>}</label>}
        </section>

        <section className="fa-step fa-options" aria-label="Options">
          <span className="fa-step-title">Options <span className="fa-opt">optional</span></span>
          {!editing&&target&&<label className="check"><input type="checkbox" aria-label="Use token for this repository" checked={connect} onChange={e=>setConnect(e.target.checked)}/>Use this account for {target.name} PRs and checks</label>}
          {kind==="bitbucket"&&<label className="check"><input type="checkbox" aria-label="Read Bitbucket profile" checked={readProfile} onChange={e=>setReadProfile(e.target.checked)}/>Read Bitbucket profile (needs read:user:bitbucket)</label>}
          <label className="check"><input type="checkbox" aria-label="Save API token in encrypted vault" checked={persist} disabled={!data?.vaultUnlocked} onChange={e=>setPersist(e.target.checked)}/>Keep after restarting (encrypted vault)</label>
          {!data?.vaultUnlocked&&<small>Without the vault the token lasts until Revqora closes. To keep it, set up or unlock the token vault on the accounts page first.</small>}
        </section>

        {kind==="bitbucket"&&<details className="fa-more"><summary>Using a Bitbucket token for Git fetch, pull and push</summary>
          <p className="help">For HTTPS Fetch/Pull/Push, select this saved account in Revqora's Git sign-in dialog, or use <code>x-bitbucket-api-token-auth</code> as the Git username and your API token as the password. OAuth tokens use <code>x-token-auth</code>. SSH remotes continue to use SSH keys.</p>
          <p className="help">Leave profile reading off to use only repository and PR scopes; Bitbucket checks which actions the token permits.</p></details>}

        <div className="hstack fa-actions"><button className="btn primary" type="button" disabled={!!missing} onClick={()=>void save()}>{kind==="bitbucket"&&!readProfile?"Save token connection":"Verify and save account"}</button><button className="btn" type="button" onClick={cancelForm}>Cancel account</button>{missing&&<span className="muted" role="status">{missing}</span>}</div>
      </fieldset>:<>
      {root&&<section className="fa-connections"><b>Repository API connection</b><code>{root}</code>
        {activeRemote&&<p>Current connection <b>{activeRemote.name} · {connectionLabel}</b></p>}
        {connections?.remotes.length?<fieldset className="fa-form" disabled={disabled}>
          <label className="field">Remote<select className="select" aria-label="API remote" value={remote} onChange={e=>setRemote(e.target.value)}>{connections.remotes.map(r=><option key={r.name} value={r.name}>{r.name} · {r.host} / {r.project}</option>)}</select></label>
          {target?.error&&<p className="fa-error">{target.error}</p>}
          <label className="field">Authentication for PRs and checks<select className="select" aria-label="Repository API account" value={account} onChange={e=>{setAccount(e.target.value);setAllowAlias(false);}}><option value="">Git credentials (automatic)</option>{data?.accounts.map(p=><option key={p.id} value={p.id} disabled={p.status!=="available"}>{providers[p.kind]} · {p.login} · {p.server}{p.status!=="available"?` · ${p.status}`:""}</option>)}{target?.accountId&&!data?.accounts.some(p=>p.id===target.accountId)&&<option value={target.accountId} disabled>Removed account — choose another</option>}</select></label>
          {alias&&<label className="check"><input type="checkbox" aria-label="Confirm SSH alias API mapping" checked={allowAlias} onChange={e=>setAllowAlias(e.target.checked)}/>Use the selected API server for this SSH host alias ({target?.host})</label>}
          <small>Automatic mode uses matching HTTPS credentials already available to Git. A selected API account uses its own token.</small>
          <button className="btn primary" type="button" disabled={alias&&!allowAlias} onClick={()=>{if(target&&connections)void perform(()=>api.forgeConnectionSelect(root,{remote:target.name,fingerprint:target.fingerprint,accountId:account||null,allowSshAlias:allowAlias},connections.revision),"API account and remote selected");}}>Use for PR and checks</button>
        </fieldset>:<p className="muted">This repository has no remotes.</p>}
        <div className="hstack"><button type="button" className="btn" disabled={disabled} onClick={()=>{close();void gitConnectionDialog(root);}}>Git connection settings…</button><button type="button" className="btn" disabled={disabled} onClick={()=>{close();void connectionCheckDialog(root,remote||null);}}>Check connection…</button></div>
      </section>}
      <div className="hstack"><b>API accounts</b><div className="spacer"/><button className="btn" type="button" disabled={disabled} onClick={()=>begin(null)}>Add API account</button><button className="icon-btn" type="button" aria-label="Refresh API accounts" disabled={disabled} onClick={()=>{setError("");void refresh();}}><RefreshCw size={15}/></button></div>
      <p className="help">Use Add API account to choose a different token for pull requests and checks.</p>
      <div className="fa-accounts">{data?.accounts.map(p=><section className="fa-card" key={p.id} data-account-id={p.id}>
        <div><b>{p.login}</b><span className="pill">{providers[p.kind]}</span><span className="pill">{p.status==="available"?"Ready":p.status==="locked"?"Locked":"Reconnect"}</span>{p.identityVerified===false&&<span className="pill">Profile not read</span>}</div>
        <small>{p.name}</small><code>{p.server}</code><small>{p.storage==="encrypted"?"Encrypted token beside the executable":"Session token · reconnect after restarting or locking"}</small>
        <div className="hstack"><button className="btn sm" type="button" disabled={disabled} onClick={()=>begin(p)}>Reconnect</button><button className="btn sm" type="button" disabled={disabled||p.status!=="available"||p.identityVerified===false&&(!root||target?.accountId!==p.id)} title={p.identityVerified===false?"Tests PR access through this repository's selected token connection":"Test API account"} onClick={()=>void perform(()=>api.forgeAccountTest(p.id,p.identityVerified===false?root:null,p.identityVerified===false&&target&&connections?{remote:target.name,fingerprint:target.fingerprint,revision:connections.revision}:undefined),"Account connection verified")}>Test connection</button><button className="btn sm danger" type="button" disabled={disabled} onClick={()=>void remove(p)}>Remove</button></div>
      </section>)}{data&&!data.accounts.length&&<p className="muted">Add a token to choose a specific API identity, or use existing Git credentials for a repository remote.</p>}</div>
      <section className="fa-vault"><div className="hstack"><KeyRound size={16}/><b>Portable token vault</b><span className="fa-opt">optional</span><span className="muted">{data?.vaultConfigured?data.vaultUnlocked?"Unlocked":"Locked":"Not configured"}</span></div>
        <p>{data?.vaultConfigured&&!data.vaultUnlocked?"Enter the vault password to use the tokens saved in it.":"Keeps API tokens after restarting. They are encrypted in data/accounts beside Revqora with a password you choose; forgetting it requires reconnecting saved accounts. Without a vault, tokens last until Revqora closes."}</p>
        {vaultFields&&data&&<fieldset className="fa-form" disabled={disabled}>
          <label className="field">Vault password<input className="input" type="password" aria-label="Vault password" autoComplete={data.vaultConfigured&&!data.vaultUnlocked?"current-password":"new-password"} value={password} onChange={e=>setPassword(e.target.value)}/></label>
          {(!data.vaultConfigured||changePassword)&&<label className="field">Confirm vault password<input className="input" type="password" aria-label="Confirm vault password" autoComplete="new-password" value={confirmation} onChange={e=>setConfirmation(e.target.value)}/></label>}
          <div className="hstack"><button className="btn" type="button" disabled={!password} onClick={()=>void vaultAction()}>{data.vaultConfigured&&!data.vaultUnlocked?"Unlock vault":data.vaultConfigured?"Save new vault password":"Create vault"}</button>{!data.vaultConfigured&&<button className="btn" type="button" onClick={()=>{setSetupVault(false);setPassword("");setConfirmation("");}}>Cancel</button>}</div>
        </fieldset>}
        <div className="hstack">{data&&!data.vaultConfigured&&!setupVault&&<button className="btn" type="button" disabled={disabled} onClick={()=>setSetupVault(true)}>Set up vault…</button>}{data?.vaultUnlocked&&<button className="btn" type="button" disabled={disabled} onClick={()=>setChangePassword(v=>!v)}>Change vault password</button>}{!!data?.accounts.length&&<button className="btn" type="button" disabled={disabled} onClick={()=>void perform(()=>api.forgeVaultLock(),"Saved tokens locked and sessions cleared")}><Lock size={14}/>Lock tokens and clear sessions</button>}{data?.vaultConfigured&&<button className="btn danger" type="button" disabled={disabled} onClick={()=>void reset()}>Forget saved tokens…</button>}</div>
      </section>
      </>}
    </div>
  </Modal>;
}
