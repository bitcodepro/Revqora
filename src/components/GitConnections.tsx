import {useEffect,useRef,useState} from "react";
import {open as openFile} from "@tauri-apps/plugin-dialog";
import {KeyRound} from "lucide-react";
import {Modal} from "./Modal";
import {api,errorMessage} from "../lib/api";
import {showDialog,toast} from "../lib/ui";
import {defaultGitConnection} from "../lib/gitConnection";
import {confirmDialog} from "./dialogs";
import type {ForgeConnections,GitConnectionOptions,GitConnectionSnapshot} from "../lib/types";
export {defaultGitConnection,gitTransport} from "../lib/gitConnection";

export function GitConnectionFields({value,onChange,transport="both",disabled=false}:{value:GitConnectionOptions;onChange:(value:GitConnectionOptions)=>void;transport?:"ssh"|"https"|"both";disabled?:boolean}){
  const patch=(change:Partial<GitConnectionOptions>)=>onChange({...value,...change});
  const pick=async(field:"privateKey"|"sshProgram")=>{const path=await openFile({multiple:false,directory:false,title:field==="privateKey"?"Choose an existing OpenSSH private key":"Choose OpenSSH executable"});if(typeof path==="string")patch({[field]:path});};
  return <fieldset className="fa-form" disabled={disabled}><b>Git authentication</b>
    <small>GitHub · Bitbucket · GitLab · Azure DevOps, including supported enterprise hosts.</small>
    {transport!=="ssh"&&<><label className="field">HTTPS authentication<select className="select" aria-label="HTTPS authentication" value={value.https} onChange={e=>patch({https:e.target.value as GitConnectionOptions["https"]})}><option value="auto">Existing Git credentials, otherwise ask in Revqora</option><option value="token">Token/password in Revqora (no external credential helper)</option><option value="browser">Browser/device sign-in with Git Credential Manager</option></select></label>
      <small>{value.https==="browser"?"Requires Git Credential Manager configured for this Git installation. It handles the provider's OAuth/SSO and stores credentials in its configured credential store. Self-hosted OAuth may need administrator setup. Background fetch never opens sign-in windows.":"Use a personal/API/access token as the password when required by your host. Revqora can remember verified HTTPS tokens on Windows and reuse them for PRs."}</small></>}
    {transport!=="https"&&<><label className="field">SSH authentication<select className="select" aria-label="SSH authentication" value={value.ssh} onChange={e=>patch({ssh:e.target.value as GitConnectionOptions["ssh"]})}><option value="auto">Existing SSH config / agent / Git SSH command</option><option value="agent">SSH agent only</option><option value="key">Choose an OpenSSH private key</option><option value="password">Password / keyboard-interactive (if the server permits)</option></select></label>
      {value.ssh==="key"&&<label className="field">Private key file<div className="hstack"><input className="input mono" aria-label="SSH private key file" value={value.privateKey} onChange={e=>patch({privateKey:e.target.value})}/><button type="button" className="btn" onClick={()=>void pick("privateKey")}>Browse key…</button></div><small>Select a file, not key contents. Add its public key to your hosting account. Passphrases are requested by SSH; private keys are not copied into Revqora.</small></label>}
      {value.ssh!=="auto"&&<small>Managed SSH modes use the full SSH hostname/port, keep host trust beside Revqora, and verify the host fingerprint. For SSH aliases, proxies, certificates, hardware keys or PuTTY/Pageant, use your existing SSH config.</small>}
      {value.ssh==="password"&&<small>GitHub, Bitbucket Cloud, GitLab.com and Azure Repos normally require SSH keys. Password mode is intended for servers that explicitly allow it.</small>}
      <details><summary>OpenSSH program (optional)</summary><label className="field">SSH executable<div className="hstack"><input className="input mono" aria-label="SSH executable" placeholder="ssh from Git/PATH" value={value.sshProgram} onChange={e=>patch({sshProgram:e.target.value})}/><button type="button" className="btn" onClick={()=>void pick("sshProgram")}>Browse program…</button></div><small>Choose Windows OpenSSH when using the Windows ssh-agent, or another OpenSSH installation. Leave empty to use Git's default. This field is for OpenSSH-compatible clients.</small></label></details></>}
    <details><summary>SSH URL examples</summary><div className="code-list">GitHub: git@github.com:owner/repo.git<br/>Bitbucket: git@bitbucket.org:workspace/repo.git<br/>GitLab: git@gitlab.com:group/repo.git<br/>Azure: git@ssh.dev.azure.com:v3/org/project/repo</div></details>
  </fieldset>;
}
export const gitConnectionDialog=(root:string)=>showDialog<void>(close=><GitConnections root={root} close={()=>close()}/>);
function GitConnections({root,close}:{root:string;close:()=>void}){
  const [snapshot,setSnapshot]=useState<GitConnectionSnapshot|null>(null),[options,setOptions]=useState(defaultGitConnection),[connections,setConnections]=useState<ForgeConnections|null>(null),[remote,setRemote]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");const active=useRef(false),mounted=useRef(true),generation=useRef(0);
  const refresh=async()=>{const id=++generation.current;try{const [s,c]=await Promise.all([api.gitConnectionSnapshot(root),api.forgeConnections(root)]);if(!mounted.current||id!==generation.current)return;setSnapshot(s);setOptions(s.options);setConnections(c);setRemote(old=>c.remotes.some(r=>r.name===old)?old:c.activeRemote??"");}catch(e){if(mounted.current&&id===generation.current)setError(errorMessage(e));}};
  useEffect(()=>{mounted.current=true;void refresh();return()=>{mounted.current=false;generation.current++;};},[root]);
  const save=async()=>{if(!snapshot||active.current)return;active.current=true;setBusy(true);setError("");try{setSnapshot(await api.gitConnectionSave(root,options,snapshot.revision));toast.success("Git authentication preferences saved");await refresh();return true;}catch(e){setError(errorMessage(e));return false;}finally{active.current=false;setBusy(false);}};
  const test=async()=>{const target=connections?.remotes.find(r=>r.name===remote);if(!target||!snapshot||active.current)return;if(!await save())return;active.current=true;setBusy(true);try{toast.success(await api.gitConnectionTest(root,target.name,target.fingerprint));}catch(e){setError(errorMessage(e));}finally{active.current=false;setBusy(false);}};
  const forget=async()=>{
    if(!await confirmDialog({title:"Forget Git tokens saved by Revqora?",message:"This clears Revqora's remembered tokens for this repository. Accounts and Git Credential Manager keep their own credentials.",confirm:"Forget tokens",danger:true}))return;
    active.current=true;setBusy(true);setError("");
    try{await api.gitConnectionForget(root);window.dispatchEvent(new CustomEvent("revqora:forge-accounts"));toast.success("Revqora's Git tokens cleared");}
    catch(e){setError(errorMessage(e));}
    finally{active.current=false;setBusy(false);}
  };
  return <Modal title="Git connection settings" icon={<KeyRound size={18}/>} wide onClose={()=>{if(!active.current)close();}} onSubmit={()=>void save()} footer={<><button type="button" className="btn" disabled={busy} onClick={close}>Close</button><button type="submit" className="btn primary" disabled={busy||!snapshot}>Save Git authentication</button></>}>
    <p>These preferences apply to this repository's Git remotes. HTTPS and SSH can be configured independently. Settings and managed SSH host trust stay in portable data beside Revqora.</p><code>{root}</code>
    {error&&<p role="alert">{error}</p>}
    <GitConnectionFields value={options} onChange={setOptions} disabled={busy||!snapshot}/>
    {snapshot&&!snapshot.credentialManagerConfigured&&<p className="help">Git Credential Manager is not configured for this Git installation. Token and SSH authentication are available; configure GCM to enable browser sign-in.</p>}
    {snapshot?.canRememberTokens&&<button type="button" className="btn" disabled={busy} onClick={()=>void forget()}>Forget Git tokens saved by Revqora…</button>}
    <fieldset className="fa-form" disabled={busy||!snapshot}><label className="field">Remote to test<select className="select" aria-label="Git remote to test" value={remote} onChange={e=>setRemote(e.target.value)}>{connections?.remotes.map(r=><option key={r.name} value={r.name}>{r.name} · {r.host} / {r.project}</option>)}</select></label><button type="button" className="btn" disabled={!remote} onClick={()=>void test()}>Save and test Git access</button><small>Reads remote heads without changing branches or files. Change a remote's HTTPS/SSH URL from its menu in the sidebar. PRs and checks use API credentials separately; an SSH key cannot authenticate to a REST API.</small></fieldset>
  </Modal>;
}
