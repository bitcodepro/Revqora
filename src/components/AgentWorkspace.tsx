import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, ExternalLink, FolderGit2, Plus, RefreshCw, Square, X } from "lucide-react";
import { open as chooseFile } from "@tauri-apps/plugin-dialog";
import { api, errorMessage } from "../lib/api";
import { agentActive, agentArgs, agentPresets, agentProfileKey, loadAgentProfile } from "../lib/agents";
import type { AgentPlan, AgentRequest, AgentTask } from "../lib/types";
import { captureOverlay, closeOverlay, openOverlay, showDialog, toast } from "../lib/ui";
import { openWorktree } from "../lib/worktreeNavigation";
import { shortOid } from "../lib/format";
import { Modal } from "./Modal";

function NewTask({root,onCreated,close}:{root:string;onCreated:(t:AgentTask)=>void;close:()=>void}) {
  const [profile] = useState(()=>loadAgentProfile(root));
  const [provider,setProvider]=useState<AgentRequest["provider"]>(profile.provider),[exe,setExe]=useState(profile.executable),[args,setArgs]=useState(JSON.stringify(profile.args));
  const [title,setTitle]=useState(""),[prompt,setPrompt]=useState(""),[base,setBase]=useState("HEAD"),[timeout,setTimeout]=useState(profile.timeoutSeconds);
  const [worktreePath,setWorktreePath]=useState("");
  const [plan,setPlan]=useState<AgentPlan|null>(null),[consent,setConsent]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(""),[uncertain,setUncertain]=useState(false);
  const inflight=useRef(false),version=useRef(0),alive=useRef(true);
  useEffect(()=>()=>{alive.current=false;version.current++;},[]);
  const invalidate=()=>{version.current++;setPlan(null);setConsent(false);setError("");};
  const prepare=async()=>{
    if(inflight.current)return;inflight.current=true;const v=++version.current;setBusy(true);setError("");
    try {const request:AgentRequest={title,provider,executable:exe,args:agentArgs(args),prompt,base,worktreePath:worktreePath||undefined,timeoutSeconds:timeout};const p=await api.agentPrepare(root,request);if(alive.current&&v===version.current){setPlan(p);setConsent(false);}}
    catch(e){if(alive.current&&v===version.current)setError(errorMessage(e));}finally{inflight.current=false;if(alive.current)setBusy(false);}
  };
  const launch=async()=>{
    if(inflight.current||!plan||!consent||uncertain)return;inflight.current=true;setBusy(true);setError("");setUncertain(true);
    try {const t=await api.agentStart(root,plan,true);try{localStorage.setItem(agentProfileKey(root),JSON.stringify({provider,executable:exe,args:plan.request.args,timeoutSeconds:timeout}));}catch{/* The durable native task remains authoritative. */}onCreated(t);close();}
    catch(e){if(alive.current)setError(`${errorMessage(e)} Refresh task history before another attempt. This confirmation cannot resend the task.`);}
    finally{inflight.current=false;if(alive.current)setBusy(false);}
  };
  return <Modal title="New agent task" icon={<Bot size={18}/>} wide onClose={()=>{if(!inflight.current)close();}} onSubmit={()=>void (plan?launch():prepare())} footer={<>
    <button type="button" className="btn" disabled={busy} onClick={close}>Close</button>
    {plan?<><button type="button" className="btn" disabled={busy||uncertain} onClick={invalidate}>Edit task</button><button type="submit" className="btn primary" disabled={busy||!consent||uncertain}>{busy?"Starting…":"Start agent"}</button></>:<button type="submit" className="btn primary" disabled={busy}>{busy?"Preparing…":"Review launch"}</button>}
  </>}>
    {error&&<p className="error-text" role="alert">{error}</p>}
    {!plan?<div className="agent-form"><label>Task title<input className="input" aria-label="Task title" maxLength={200} value={title} onChange={e=>{invalidate();setTitle(e.target.value);}} disabled={busy}/></label>
      <label>Agent<select className="input" aria-label="Agent provider" value={provider} disabled={busy} onChange={e=>{invalidate();const p=e.target.value as AgentRequest["provider"];setProvider(p);setArgs(JSON.stringify(agentPresets[p]));}}><option value="codex">Codex CLI</option><option value="claude">Claude Code</option><option value="custom">Other CLI (stdin prompt)</option></select></label>
      <label>Executable<div className="agent-inline"><input className="input" aria-label="Agent executable" placeholder="Absolute path to the installed executable" value={exe} onChange={e=>{invalidate();setExe(e.target.value);}} disabled={busy}/><button type="button" className="btn" disabled={busy} onClick={()=>void chooseFile({multiple:false,directory:false}).then(p=>{if(typeof p==="string"&&alive.current){invalidate();setExe(p);}},e=>toast.error(e))}>Browse…</button></div></label>
      <label>Arguments (JSON array)<textarea className="input mono" aria-label="Agent arguments" rows={3} value={args} onChange={e=>{invalidate();setArgs(e.target.value);}} disabled={busy}/></label>
      <small className="muted">Executed directly, without a shell. npm installations: select node.exe and insert the CLI's absolute .js path as the first argument. The task is sent through stdin. No API key belongs in these fields.</small>
      <div className="agent-inline"><label>Start from<input className="input" aria-label="Agent base" value={base} onChange={e=>{invalidate();setBase(e.target.value);}} disabled={busy}/></label><label>Timeout (seconds)<input className="input" type="number" min={1} max={14400} aria-label="Agent timeout" value={timeout} onChange={e=>{invalidate();setTimeout(Number(e.target.value));}} disabled={busy}/></label></div>
      <label>Worktree folder (optional)<input className="input" aria-label="Agent worktree folder" placeholder="Default: portable data beside the executable" value={worktreePath} onChange={e=>{invalidate();setWorktreePath(e.target.value);}} disabled={busy}/><small className="muted">A new folder outside all existing worktrees. Choose one explicitly if the portable app itself is inside this repository. Logs, history and profiles always stay beside the executable.</small></label>
      <label>Task<textarea className="input" aria-label="Agent prompt" rows={6} maxLength={32768} value={prompt} onChange={e=>{invalidate();setPrompt(e.target.value);}} disabled={busy}/></label>
    </div>:<div className="agent-review" data-agent-review>
      <h4>{plan.request.title}</h4><dl><dt>Executable</dt><dd><code>{plan.request.executable}</code></dd><dt>Arguments</dt><dd><code>{JSON.stringify(plan.request.args)}</code></dd><dt>Base commit</dt><dd><code>{plan.creation.startOid}</code></dd><dt>New branch</dt><dd><code>{plan.creation.request.branch}</code></dd><dt>New worktree</dt><dd><code>{plan.creation.path}</code></dd><dt>Portable agent home</dt><dd><code>{plan.profilePath}</code></dd><dt>Timeout</dt><dd>{plan.request.timeoutSeconds} seconds</dd></dl>
      <pre className="agent-prompt">{plan.request.prompt}</pre>
      <p>The selected CLI can send code to its configured service and execute tools. A worktree separates working files; it is not an OS sandbox. Linked worktrees share Git history. The command's own permissions apply.</p>
      <p>Revqora asks the agent to leave changes uncommitted. This instruction is not a security boundary. Revqora does not automatically commit, push, merge or delete the worktree. Other app operations for this repository wait until the process stops.</p>
      <p>CLI home, configuration, cache and temp directories are redirected to the portable profile above. Authenticate that CLI in this profile first; your existing home profile is not copied. Repository hooks/configuration and external tools can have their own side effects.</p>
      <button type="button" className="btn" onClick={()=>void api.revealPath(plan.profilePath).catch(e=>toast.error(e))}>Open portable profile folder</button>
      <label className="check-row"><input type="checkbox" aria-label="Allow agent execution" checked={consent} disabled={busy||uncertain} onChange={e=>setConsent(e.target.checked)}/>I reviewed this command and allow this task to access code and its configured service.</label>
    </div>}
  </Modal>;
}

export function AgentWorkspace({root}:{root:string}) {
  const [tasks,setTasks]=useState<AgentTask[]>([]),[selected,setSelected]=useState<string|null>(null),[error,setError]=useState(""),[loading,setLoading]=useState(true),[acting,setActing]=useState(false);
  const busy=useRef(false),generation=useRef(0),mounted=useRef(true);
  const running=tasks.some(t=>agentActive(t.phase));
  const refresh=useCallback(async()=>{if(busy.current)return;busy.current=true;const g=generation.current;try{const list=await api.agentTasks(root);if(mounted.current&&g===generation.current){setTasks(list);setSelected(s=>list.some(t=>t.id===s)?s:list[0]?.id??null);setError("");}}catch(e){if(mounted.current&&g===generation.current)setError(errorMessage(e));}finally{busy.current=false;if(mounted.current)setLoading(false);}},[root]);
  useEffect(()=>{mounted.current=true;void refresh();let timer:ReturnType<typeof setTimeout>;let closed=false;const tick=()=>{timer=setTimeout(()=>{if(!closed){void refresh().finally(()=>{if(!closed)tick();});}},running?1000:10000);};tick();return()=>{closed=true;mounted.current=false;generation.current++;clearTimeout(timer);};},[refresh,running]);
  const task=tasks.find(t=>t.id===selected);
  const action=async(run:()=>Promise<void>)=>{if(acting)return;generation.current++;setActing(true);try{await run();}catch(e){toast.error(e);}finally{generation.current++;if(mounted.current)setActing(false);await refresh();}};
  const forget=async(t:AgentTask)=>{const ok=await showDialog<boolean>(close=><Modal title="Forget task history?" onClose={()=>close(false)} onSubmit={()=>close(true)} footer={<><button type="button" className="btn" onClick={()=>close(false)}>Cancel</button><button type="submit" className="btn danger">Forget history</button></>}><p>Removes this task's local record and log. Its branch, worktree and all files are kept. Use Worktree Manager for reviewed removal.</p></Modal>);if(ok)await api.agentForget(root,t.id);};
  const acknowledge=async(t:AgentTask)=>{const ok=await showDialog<boolean>(close=><Modal title="Confirm interrupted process stopped" onClose={()=>close(false)} onSubmit={()=>close(true)} footer={<><button type="button" className="btn" onClick={()=>close(false)}>Cancel</button><button type="submit" className="btn warn">I checked: processes stopped</button></>}><p>Check your system process list and stop the CLI and its tools first. Revqora cannot determine whether an agent survived an unexpected app exit. This acknowledgement records an unknown result and keeps all changes.</p></Modal>);if(ok)await api.agentAcknowledge(root,t.id,true);};
  return <section className="conflict-overlay agent-workspace" aria-label="Agent Workspace"><header className="cf-head"><Bot size={18}/><b>Agent Workspace</b><span className="muted">{tasks.length} tasks</span><div className="spacer"/>
    <button type="button" className="btn primary" disabled={running||acting||loading||!!error} onClick={()=>void showDialog<void>(close=><NewTask root={root} close={()=>{close();void refresh();}} onCreated={t=>{generation.current++;setTasks(old=>[t,...old.filter(x=>x.id!==t.id)]);setSelected(t.id);}}/>)}><Plus size={14}/>New task</button>
    <button type="button" className="icon-btn" aria-label="Refresh agent tasks" onClick={()=>void refresh()}><RefreshCw size={16}/></button><button type="button" className="icon-btn" aria-label="Close Agent Workspace" onClick={closeOverlay}><X size={18}/></button>
  </header><p className="agent-notice">Separate worktrees · one agent per repository · explicit execution · changes kept for review</p>{error&&<p role="alert" className="error-text">{error}</p>}
  <div className="agent-layout"><nav className="agent-tasks" aria-label="Agent tasks">{tasks.map(t=><button type="button" key={t.id} className={`agent-task ${t.id===selected?"selected":""}`} aria-pressed={t.id===selected} onClick={()=>setSelected(t.id)}><b>{t.title}</b><span>{t.provider} · {t.phase}</span><small>{new Date(t.createdAt).toLocaleString()} · {Math.round(t.elapsedMs/1000)}s</small></button>)}{!tasks.length&&<p>{loading?"Loading tasks…":"No tasks yet. Start an agent in a new worktree."}</p>}</nav>
  <main className="agent-detail">{task?<>
    <header><h3>{task.title}</h3><span className={`agent-phase phase-${task.phase}`}>{task.phase}</span><span className="muted">{Math.round(task.elapsedMs/1000)}s {task.exitCode!==null?`· exit ${task.exitCode}`:""}</span></header>
    <div className="agent-path"><FolderGit2 size={14}/><code>{task.path}</code></div><p className="muted"><code>{task.branch}</code> from <code>{shortOid(task.baseOid)}</code></p>
    {task.error&&<p role="alert" className="error-text">{task.error}</p>}
    {task.phase==="external"&&<p>Another Revqora window may be running this task. Stop it there before using this repository.</p>}
    {task.phase==="interrupted"&&<p>The app ended before recording completion. Process state is unknown; inspect running tools before continuing. Files and the locked worktree were retained.</p>}
    <div className="agent-actions">{["queued","running","stopping"].includes(task.phase)&&<button type="button" className="btn warn" disabled={acting||task.phase==="stopping"} onClick={()=>void action(()=>api.agentStop(root,task.id))}><Square size={13}/>Stop process tree</button>}
    {task.phase==="interrupted"&&<button type="button" className="btn warn" disabled={acting} onClick={()=>void action(()=>acknowledge(task))}>Confirm process stopped…</button>}
    <button type="button" className="btn primary" disabled={running||acting} onClick={()=>void openWorktree(task.path,captureOverlay("agents",root))}><ExternalLink size={14}/>Open changes</button>
    <button type="button" className="btn" disabled={running} onClick={()=>openOverlay({kind:"worktrees",root})}>Worktree Manager</button>
    <button type="button" className="btn" onClick={()=>void api.revealPath(task.profilePath).catch(e=>toast.error(e))}>Agent profile</button>
    <button type="button" className="btn" disabled={running||acting} onClick={()=>void action(()=>forget(task))}>Forget history</button></div>
    <details><summary>Task, launch details and portable authentication</summary><pre>{task.prompt}</pre><p><code>{task.executable}</code></p><pre>{JSON.stringify(task.args)}</pre><p>Agent home: <code>{task.profilePath}</code>. To sign in from a terminal, set HOME and USERPROFILE to this directory, CODEX_HOME to its codex subfolder or CLAUDE_CONFIG_DIR to its claude subfolder, then run your installed CLI's login command. No credentials are copied from your usual home.</p></details>
    <div className="agent-log"><h4>Output</h4><pre aria-label="Agent output">{task.stdout||"No stdout yet."}</pre><h4>Diagnostics</h4><pre aria-label="Agent diagnostics">{task.stderr||"No stderr."}</pre>{task.truncated&&<p className="warn-text">Output truncated to 128 KiB per stream; the process continued draining both pipes.</p>}</div>
    {!agentActive(task.phase)&&<p className="muted">The worktree is kept and locked. Review its changes, then unlock and remove it explicitly in Worktree Manager. A completed process does not mean its changes passed tests.</p>}
  </>:<div className="agent-empty"><Bot size={32}/><h3>Give each task its own working directory</h3><p>Choose an installed CLI, review the command and start explicitly. Follow output here, then inspect its changes in Revqora.</p></div>}</main></div></section>;
}
