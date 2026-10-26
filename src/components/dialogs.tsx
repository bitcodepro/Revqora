import { Fragment, useEffect, useState, type ReactNode } from "react";
import { useUpdate } from "../lib/update";
import { SHORTCUTS, bindingFor, comboFromEvent, prettyCombo } from "../lib/shortcuts";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertTriangle,
  ArrowRight,
  Archive,
  CloudUpload,
  Download,
  FolderOpen,
  GitBranch,
  GitMerge,
  History,
  Info,
  Pencil,
  RotateCcw,
  Settings2,
  Tag,
  Trash2,
  UserRound,
} from "lucide-react";
import { Modal } from "./Modal";
import { showDialog, toast } from "../lib/ui";
import { api, errorMessage } from "../lib/api";
import { CODE_FONTS, UI_FONTS, useSettings } from "../lib/settings";
import type { GitSelection, PushOptions, ReflogEntry, RemoteInfo, SigningConfig } from "../lib/types";
import { useRepos } from "../lib/store";
import { absoluteTime, relativeTime, shortOid } from "../lib/format";

// ───────────── generic ─────────────

export function confirmDialog(o: {
  title: string;
  message?: ReactNode;
  confirm?: string;
  danger?: boolean;
  icon?: ReactNode;
  details?: string[];
}): Promise<boolean> {
  return showDialog<boolean>((close) => (
    <Modal
      title={o.title}
      icon={o.icon ?? (o.danger ? <AlertTriangle size={18} /> : <Info size={18} />)}
      tone={o.danger ? "danger" : "accent"}
      onClose={() => close(false)}
      onSubmit={() => close(true)}
      footer={
        <>
          <button type="button" className="btn" onClick={() => close(false)}>
            Cancel
          </button>
          <button type="submit" className={`btn ${o.danger ? "danger" : "primary"}`}>
            {o.confirm ?? "OK"}
          </button>
        </>
      }
    >
      {o.message && <div className="muted">{o.message}</div>}
      {o.details && o.details.length > 0 && <div className="code-list">{o.details.join("\n")}</div>}
    </Modal>
  ));
}

export function promptDialog(o: {
  title: string;
  label?: string;
  initial?: string;
  placeholder?: string;
  confirm?: string;
  multiline?: boolean;
  icon?: ReactNode;
  help?: ReactNode;
  validate?: (v: string) => string | null;
}): Promise<string | null> {
  return showDialog<string | null>((close) => <PromptBody o={o} close={close} />);
}

function PromptBody({ o, close }: { o: Parameters<typeof promptDialog>[0]; close: (v: string | null) => void }) {
  const [v, setV] = useState(o.initial ?? "");
  const err = v.trim() ? o.validate?.(v) ?? null : null;
  const submit = () => {
    if (!v.trim() || err) return;
    close(v);
  };
  return (
    <Modal
      title={o.title}
      icon={o.icon ?? <Pencil size={18} />}
      wide={o.multiline}
      onClose={() => close(null)}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="btn" onClick={() => close(null)}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!v.trim() || !!err}>
            {o.confirm ?? "OK"}
          </button>
        </>
      }
    >
      <div className="field">
        {o.label && <label>{o.label}</label>}
        {o.multiline ? (
          <textarea className="textarea mono" rows={8} value={v} placeholder={o.placeholder} onChange={(e) => setV(e.target.value)} />
        ) : (
          <input className="input" value={v} placeholder={o.placeholder} onChange={(e) => setV(e.target.value)} />
        )}
        {err ? <div className="err">{err}</div> : o.help ? <div className="help">{o.help}</div> : null}
      </div>
    </Modal>
  );
}

export function validBranchName(v: string): string | null {
  const s = v.trim();
  if (/\s/.test(s)) return "Branch names cannot contain spaces.";
  if (/(\.\.|[~^:?*[\\]|@\{)/.test(s)) return "Contains characters Git does not allow (.. ~ ^ : ? * [ \\ @{).";
  if (s.startsWith("-") || s.startsWith("/") || s.endsWith("/") || s.endsWith(".") || s.endsWith(".lock")) return "Invalid start or end of the name.";
  return null;
}

// ───────────── branches ─────────────

export function createBranchDialog(startLabel: string): Promise<{ name: string; checkout: boolean } | null> {
  return showDialog((close) => <CreateBranchBody startLabel={startLabel} close={close} />);
}

function CreateBranchBody({ startLabel, close }: { startLabel: string; close: (v: { name: string; checkout: boolean } | null) => void }) {
  const [name, setName] = useState("");
  const [checkout, setCheckout] = useState(true);
  const err = name.trim() ? validBranchName(name) : null;
  const submit = () => name.trim() && !err && close({ name: name.trim(), checkout });
  return (
    <Modal
      title="Create branch"
      subtitle={
        <>
          Starting at <b className="mono">{startLabel}</b>
        </>
      }
      icon={<GitBranch size={18} />}
      onClose={() => close(null)}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="btn" onClick={() => close(null)}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!name.trim() || !!err}>
            Create branch
          </button>
        </>
      }
    >
      <div className="field">
        <label>Branch name</label>
        <input className="input mono" value={name} placeholder="feature/my-change" onChange={(e) => setName(e.target.value)} />
        {err && <div className="err">{err}</div>}
      </div>
      <label className="check">
        <input type="checkbox" checked={checkout} onChange={(e) => setCheckout(e.target.checked)} /> Switch to the new branch
      </label>
    </Modal>
  );
}

// ───────────── merge ─────────────

export type MergeStrategy = "no-ff" | "ff" | "ff-only" | "squash";

export function mergeDialog(target: string, current: string): Promise<MergeStrategy | null> {
  return showDialog((close) => <MergeBody target={target} current={current} close={close} />);
}

function MergeBody({ target, current, close }: { target: string; current: string; close: (v: MergeStrategy | null) => void }) {
  const [s, setS] = useState<MergeStrategy>("no-ff");
  const opts: { v: MergeStrategy; t: string; d: string }[] = [
    { v: "no-ff", t: "Merge commit", d: "Always creates a merge commit. You review the result and confirm before it is created." },
    { v: "ff", t: "Fast-forward if possible", d: "Moves the branch pointer when histories did not diverge; otherwise stops for review like a merge commit." },
    { v: "squash", t: "Squash", d: "Stages all changes of the branch as one new commit for you to review and confirm." },
  ];
  return (
    <Modal
      title="Merge branch"
      icon={<GitMerge size={18} />}
      onClose={() => close(null)}
      onSubmit={() => close(s)}
      footer={
        <>
          <button type="button" className="btn" onClick={() => close(null)}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            <GitMerge size={15} /> Start merge
          </button>
        </>
      }
    >
      <div className="flow">
        <span className="ref local">
          <GitBranch size={11} />
          <span className="rn">{target}</span>
        </span>
        <ArrowRight size={16} className="arrow" />
        <span className="ref head">
          <GitBranch size={11} />
          <span className="rn">{current}</span>
        </span>
      </div>
      <div className="radio-cards">
        {opts.map((o) => (
          <label key={o.v} className={`radio-card ${s === o.v ? "on" : ""}`}>
            <input type="radio" checked={s === o.v} onChange={() => setS(o.v)} />
            <div>
              <div className="rt">{o.t}</div>
              <div className="rd">{o.d}</div>
            </div>
          </label>
        ))}
      </div>
      <div className="callout">
        <Info size={15} />
        <div>Nothing is committed until you press Confirm merge. If conflicts appear you can resolve them in the editor, or abort to roll everything back.</div>
      </div>
    </Modal>
  );
}

// ───────────── push ─────────────

export function pushDialog(o: { branch: string; remotes: RemoteInfo[]; upstream: string | null; ahead: number; behind: number }): Promise<PushOptions | null> {
  return showDialog((close) => <PushBody o={o} close={close} />);
}

function PushBody({ o, close }: { o: Parameters<typeof pushDialog>[0]; close: (v: PushOptions | null) => void }) {
  const upRemote = o.upstream?.split("/")[0];
  const upBranch = o.upstream ? o.upstream.slice(o.upstream.indexOf("/") + 1) : null;
  const [remote, setRemote] = useState(upRemote ?? o.remotes[0]?.name ?? "origin");
  const [remoteBranch, setRemoteBranch] = useState(upBranch ?? o.branch);
  const [setUp, setSetUp] = useState(!o.upstream);
  const [force, setForce] = useState(o.behind > 0);
  const [tags, setTags] = useState(false);
  return (
    <Modal
      title="Push"
      subtitle={o.upstream ? `${o.ahead} commit(s) ahead of ${o.upstream}` : "This branch has no upstream yet"}
      icon={<CloudUpload size={18} />}
      onClose={() => close(null)}
      onSubmit={() => close({ remote, branch: o.branch, remoteBranch, setUpstream: setUp, forceWithLease: force, tags })}
      footer={
        <>
          <button type="button" className="btn" onClick={() => close(null)}>
            Cancel
          </button>
          <button type="submit" className={`btn ${force ? "warn" : "primary"}`} disabled={!remote}>
            <CloudUpload size={15} /> {force ? "Force push" : "Push"}
          </button>
        </>
      }
    >
      <div className="flow">
        <span className="ref head">
          <GitBranch size={11} /> <span className="rn">{o.branch}</span>
        </span>
        <ArrowRight size={16} className="arrow" />
        <select className="select" style={{ width: 140 }} value={remote} onChange={(e) => setRemote(e.target.value)}>
          {o.remotes.map((r) => (
            <option key={r.name}>{r.name}</option>
          ))}
        </select>
        <span className="faint">/</span>
        <input className="input mono" style={{ flex: 1, minWidth: 140 }} value={remoteBranch} onChange={(e) => setRemoteBranch(e.target.value)} />
      </div>
      <div className="vstack" style={{ gap: 10 }}>
        <label className="check">
          <input type="checkbox" checked={setUp} onChange={(e) => setSetUp(e.target.checked)} /> Track this remote branch (set upstream)
        </label>
        <label className="check">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> Force push (with lease — refuses if someone else pushed)
        </label>
        <label className="check">
          <input type="checkbox" checked={tags} onChange={(e) => setTags(e.target.checked)} /> Also push all tags
        </label>
      </div>
      {o.behind > 0 && (
        <div className="callout warn">
          <AlertTriangle size={15} />
          <div>The remote has {o.behind} commit(s) you do not have. Pull first, or force push to overwrite them.</div>
        </div>
      )}
    </Modal>
  );
}

// ───────────── stash ─────────────

export function stashDialog(): Promise<{ message: string; untracked: boolean; keepIndex: boolean } | null> {
  return showDialog((close) => <StashBody close={close} />);
}

function StashBody({ close }: { close: (v: { message: string; untracked: boolean; keepIndex: boolean } | null) => void }) {
  const [message, setMessage] = useState("");
  const [untracked, setUntracked] = useState(true);
  const [keepIndex, setKeepIndex] = useState(false);
  return (
    <Modal
      title="Stash changes"
      icon={<Archive size={18} />}
      onClose={() => close(null)}
      onSubmit={() => close({ message, untracked, keepIndex })}
      footer={
        <>
          <button type="button" className="btn" onClick={() => close(null)}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            <Archive size={15} /> Stash
          </button>
        </>
      }
    >
      <div className="field">
        <label>Message (optional)</label>
        <input className="input" value={message} placeholder="Work in progress" onChange={(e) => setMessage(e.target.value)} />
      </div>
      <label className="check">
        <input type="checkbox" checked={untracked} onChange={(e) => setUntracked(e.target.checked)} /> Include untracked files
      </label>
      <label className="check">
        <input type="checkbox" checked={keepIndex} onChange={(e) => setKeepIndex(e.target.checked)} /> Keep staged changes in place
      </label>
    </Modal>
  );
}

// ───────────── tag ─────────────

export function tagDialog(target: string): Promise<{ name: string; message: string } | null> {
  return showDialog((close) => <TagBody target={target} close={close} />);
}

function TagBody({ target, close }: { target: string; close: (v: { name: string; message: string } | null) => void }) {
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const err = name.trim() ? validBranchName(name) : null;
  return (
    <Modal
      title="Create tag"
      subtitle={
        <>
          At <span className="mono">{shortOid(target)}</span>
        </>
      }
      icon={<Tag size={18} />}
      onClose={() => close(null)}
      onSubmit={() => name.trim() && !err && close({ name: name.trim(), message })}
      footer={
        <>
          <button type="button" className="btn" onClick={() => close(null)}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!name.trim() || !!err}>
            Create tag
          </button>
        </>
      }
    >
      <div className="field">
        <label>Tag name</label>
        <input className="input mono" value={name} placeholder="v1.0.0" onChange={(e) => setName(e.target.value)} />
        {err && <div className="err">{err}</div>}
      </div>
      <div className="field">
        <label>Message</label>
        <textarea className="textarea" rows={3} value={message} placeholder="Leave empty for a lightweight tag" onChange={(e) => setMessage(e.target.value)} />
      </div>
    </Modal>
  );
}

// ───────────── reset ─────────────

export function resetDialog(branch: string, target: string, subject: string): Promise<"soft" | "mixed" | "hard" | "keep" | null> {
  return showDialog((close) => <ResetBody branch={branch} target={target} subject={subject} close={close} />);
}

function ResetBody({ branch, target, subject, close }: { branch: string; target: string; subject: string; close: (v: "soft" | "mixed" | "hard" | "keep" | null) => void }) {
  const [m, setM] = useState<"soft" | "mixed" | "hard" | "keep">("mixed");
  const opts = [
    { v: "soft" as const, t: "Soft", d: "Move the branch only. Changes of the removed commits stay staged." },
    { v: "mixed" as const, t: "Mixed", d: "Move the branch and unstage. Changes stay in your working files." },
    { v: "keep" as const, t: "Keep", d: "Like hard, but refuses if it would overwrite your uncommitted changes." },
    { v: "hard" as const, t: "Hard", d: "Discard everything after this commit, including uncommitted changes." },
  ];
  return (
    <Modal
      title={`Reset ${branch} to this commit`}
      subtitle={
        <>
          <span className="mono">{shortOid(target)}</span> {subject}
        </>
      }
      icon={<RotateCcw size={18} />}
      tone={m === "hard" ? "danger" : "warn"}
      onClose={() => close(null)}
      onSubmit={() => close(m)}
      footer={
        <>
          <button type="button" className="btn" onClick={() => close(null)}>
            Cancel
          </button>
          <button type="submit" className={`btn ${m === "hard" ? "danger" : "primary"}`}>
            Reset
          </button>
        </>
      }
    >
      <div className="radio-cards">
        {opts.map((o) => (
          <label key={o.v} className={`radio-card ${m === o.v ? "on" : ""}`}>
            <input type="radio" checked={m === o.v} onChange={() => setM(o.v)} />
            <div>
              <div className="rt">{o.t}</div>
              <div className="rd">{o.d}</div>
            </div>
          </label>
        ))}
      </div>
    </Modal>
  );
}

// ───────────── clone / init ─────────────

export function cloneDialog(): Promise<{ url: string; parent: string; name: string } | null> {
  return showDialog((close) => <CloneBody close={close} />);
}

function repoNameFromUrl(url: string): string {
  const m = url.trim().replace(/\/+$/, "").match(/([^/:\\]+?)(\.git)?$/);
  return m ? m[1] : "";
}

function CloneBody({ close }: { close: (v: { url: string; parent: string; name: string } | null) => void }) {
  const [url, setUrl] = useState("");
  const [parent, setParent] = useState(localStorage.getItem("revqora.cloneParent") ?? "");
  const [name, setName] = useState("");
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched) setName(repoNameFromUrl(url));
  }, [url, touched]);
  const pick = async () => {
    const dir = await openDialog({ directory: true, title: "Choose where to clone" });
    if (typeof dir === "string") setParent(dir);
  };
  const ok = url.trim() && parent.trim() && name.trim();
  return (
    <Modal
      title="Clone repository"
      icon={<Download size={18} />}
      onClose={() => close(null)}
      onSubmit={() => {
        if (!ok) return;
        localStorage.setItem("revqora.cloneParent", parent);
        close({ url: url.trim(), parent: parent.trim(), name: name.trim() });
      }}
      footer={
        <>
          <button type="button" className="btn" onClick={() => close(null)}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!ok}>
            Clone
          </button>
        </>
      }
    >
      <div className="field">
        <label>Repository URL</label>
        <input className="input mono" value={url} placeholder="https://github.com/user/repo.git" onChange={(e) => setUrl(e.target.value)} />
      </div>
      <div className="field">
        <label>Parent folder</label>
        <div className="hstack">
          <input className="input" value={parent} onChange={(e) => setParent(e.target.value)} />
          <button type="button" className="btn" onClick={pick}>
            <FolderOpen size={15} /> Browse
          </button>
        </div>
      </div>
      <div className="field">
        <label>Folder name</label>
        <input
          className="input"
          value={name}
          onChange={(e) => {
            setTouched(true);
            setName(e.target.value);
          }}
        />
      </div>
    </Modal>
  );
}

// ───────────── identity ─────────────

export function identityDialog(root: string): Promise<boolean> {
  return showDialog((close) => <IdentityBody root={root} close={close} />);
}

function IdentityBody({ root, close }: { root: string; close: (v: boolean) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [global, setGlobal] = useState(true);
  useEffect(() => {
    api.identityGet(root).then((i) => {
      setName(i.name ?? "");
      setEmail(i.email ?? "");
    });
  }, [root]);
  const save = async () => {
    try {
      await api.identitySet(root, name, email, global);
      toast.success("Identity saved");
      close(true);
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Modal
      title="Who are you?"
      subtitle="Git needs a name and email to record as the author of your commits."
      icon={<UserRound size={18} />}
      onClose={() => close(false)}
      onSubmit={save}
      footer={
        <>
          <button type="button" className="btn" onClick={() => close(false)}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!name.trim() || !email.trim()}>
            Save
          </button>
        </>
      }
    >
      <div className="field">
        <label>Name</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label>Email</label>
        <input className="input" value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <label className="check">
        <input type="checkbox" checked={global} onChange={(e) => setGlobal(e.target.checked)} /> Use for all repositories (global)
      </label>
    </Modal>
  );
}

// ───────────── reflog ─────────────

export function reflogDialog(root: string, onReset: (oid: string) => void): Promise<void> {
  return showDialog<void>((close) => <ReflogBody root={root} close={close} onReset={onReset} />);
}

function ReflogBody({ root, close, onReset }: { root: string; close: () => void; onReset: (oid: string) => void }) {
  const [items, setItems] = useState<ReflogEntry[] | null>(null);
  useEffect(() => {
    api.reflog(root).then(setItems, (e) => toast.error(e));
  }, [root]);
  return (
    <Modal
      title="Undo history (reflog)"
      subtitle="Every position HEAD has been at. Reset to any of them to undo commits, rebases or resets."
      icon={<History size={18} />}
      wide
      onClose={() => close()}
      footer={
        <button type="button" className="btn" onClick={() => close()}>
          Close
        </button>
      }
    >
      <div style={{ maxHeight: "55vh", overflow: "auto", margin: "0 -8px" }}>
        {!items && <div className="loading-center">Loading…</div>}
        {items?.map((it) => (
          <div className="reflog-row" key={it.selector}>
            <span className="mono faint">{shortOid(it.oid)}</span>
            <span className="ellipsis">{it.message}</span>
            <span className="faint" title={absoluteTime(it.time)}>
              {relativeTime(it.time)}
            </span>
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                close();
                onReset(it.oid);
              }}
            >
              Reset here…
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}

// ───────────── settings ─────────────

export function settingsDialog(root: string | null): Promise<void> {
  return showDialog<void>((close) => <SettingsBody root={root} close={close} />);
}

function UpdateSettings() {
  const checkUpdates = useSettings((s) => s.checkUpdates);
  const set = useSettings((s) => s.set);
  const { info, phase, error, check } = useUpdate();
  let status = "";
  if (phase === "checking") status = "Checking…";
  else if (phase === "error" && error) status = error;
  else if (info) status = info.available ? `Revqora ${info.latest} is available — see the status bar.` : `You have the latest version (${info.current}).`;
  return (
    <>
      <div className="section-title">Updates</div>
      <div className="settings-grid">
        <label>Updates</label>
        <div className="vstack" style={{ gap: 6 }}>
          <label className="check">
            <input type="checkbox" checked={checkUpdates} onChange={(e) => set({ checkUpdates: e.target.checked, skippedUpdate: null })} /> Check for new versions at startup
          </label>
          <span className="hstack" style={{ gap: 8 }}>
            <button
              type="button"
              className="btn sm ghost"
              disabled={phase === "checking"}
              onClick={() => {
                set({ skippedUpdate: null });
                check(true);
              }}
            >
              Check now
            </button>
            <span className="faint" style={phase === "error" ? { color: "var(--red)" } : undefined}>
              {status}
            </span>
          </span>
        </div>
      </div>
    </>
  );
}

function SettingsBody({ root, close }: { root: string | null; close: () => void }) {
  const s = useSettings();
  const [sel, setSel] = useState<GitSelection | null>(null);
  const [gitErr, setGitErr] = useState("");
  useEffect(() => {
    api.gitSelection().then(setSel, (e) => setGitErr(errorMessage(e)));
  }, []);
  const redetect = async () => {
    try {
      setSel(await api.gitConfigure());
      if (root) useRepos.getState().refresh(root);
    } catch (e) {
      setGitErr(errorMessage(e));
    }
  };

  return (
    <Modal
      title="Settings"
      icon={<Settings2 size={18} />}
      wide
      onClose={() => close()}
      footer={
        <button type="button" className="btn primary" onClick={() => close()}>
          Done
        </button>
      }
    >
      <div className="section-title">Appearance</div>
      <div className="settings-grid">
        <label>Theme</label>
        <div className="seg">
          {(["system", "dark", "light"] as const).map((t) => (
            <button type="button" key={t} className={s.theme === t ? "on" : ""} onClick={() => s.set({ theme: t })}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <label>Interface font</label>
        <div className="hstack">
          <select className="select" value={s.uiFont} onChange={(e) => s.set({ uiFont: e.target.value })}>
            {UI_FONTS.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
          <input
            className="input"
            type="number"
            min={11}
            max={18}
            step={0.5}
            style={{ width: 90 }}
            value={s.uiFontSize}
            onChange={(e) => s.set({ uiFontSize: Math.min(18, Math.max(11, Number(e.target.value) || 13)) })}
          />
        </div>
        <label>Code font</label>
        <div className="hstack">
          <select className="select" value={s.codeFont} onChange={(e) => s.set({ codeFont: e.target.value })}>
            {CODE_FONTS.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
          <input
            className="input"
            type="number"
            min={10}
            max={20}
            step={0.5}
            style={{ width: 90 }}
            value={s.codeFontSize}
            onChange={(e) => s.set({ codeFontSize: Math.min(20, Math.max(10, Number(e.target.value) || 12.5)) })}
          />
        </div>
        <label>Avatars</label>
        <label className="check" title="Loads pictures from Gravatar / GitHub; the author's email is sent as a SHA-256 hash">
          <input type="checkbox" checked={s.avatars} onChange={(e) => s.set({ avatars: e.target.checked })} /> Show author pictures (Gravatar / GitHub)
        </label>
        <label>Dates</label>
        <div className="seg">
          <button type="button" className={s.dateStyle === "relative" ? "on" : ""} onClick={() => s.set({ dateStyle: "relative" })}>
            Relative
          </button>
          <button type="button" className={s.dateStyle === "absolute" ? "on" : ""} onClick={() => s.set({ dateStyle: "absolute" })}>
            Absolute
          </button>
        </div>
      </div>
      <div className="section-title">Diff</div>
      <div className="settings-grid">
        <label>Layout</label>
        <div className="seg">
          <button type="button" className={s.diffMode === "unified" ? "on" : ""} onClick={() => s.set({ diffMode: "unified" })}>
            Unified
          </button>
          <button type="button" className={s.diffMode === "split" ? "on" : ""} onClick={() => s.set({ diffMode: "split" })}>
            Side by side
          </button>
        </div>
        <label>Context lines</label>
        <input
          className="input"
          type="number"
          min={0}
          max={50}
          style={{ width: 90 }}
          value={s.contextLines}
          onChange={(e) => s.set({ contextLines: Math.min(50, Math.max(0, Number(e.target.value) || 0)) })}
        />
        <label>Options</label>
        <div className="vstack" style={{ gap: 8 }}>
          <label className="check">
            <input type="checkbox" checked={s.ignoreWhitespace} onChange={(e) => s.set({ ignoreWhitespace: e.target.checked })} /> Ignore whitespace changes
          </label>
          <label className="check">
            <input type="checkbox" checked={s.wrapDiff} onChange={(e) => s.set({ wrapDiff: e.target.checked })} /> Wrap long lines
          </label>
        </div>
      </div>
      <div className="section-title">Behaviour</div>
      <div className="settings-grid">
        <label>Pull</label>
        <div className="seg">
          {(["ff-only", "merge", "rebase"] as const).map((m) => (
            <button type="button" key={m} className={s.pullMode === m ? "on" : ""} onClick={() => s.set({ pullMode: m })}>
              {m === "ff-only" ? "Fast-forward only" : m === "merge" ? "Merge" : "Rebase"}
            </button>
          ))}
        </div>
        <label>Auto fetch</label>
        <div className="seg">
          {[0, 1, 5, 15, 30].map((m) => (
            <button type="button" key={m} className={s.autoFetchMinutes === m ? "on" : ""} onClick={() => s.set({ autoFetchMinutes: m })}>
              {m === 0 ? "Off" : `${m} min`}
            </button>
          ))}
        </div>
        <label>Large files</label>
        <div className="hstack">
          <span className="faint">Warn when a staged file is bigger than</span>
          <input
            className="input"
            type="number"
            min={1}
            max={2000}
            style={{ width: 90 }}
            value={s.largeFileMb}
            onChange={(e) => s.set({ largeFileMb: Math.max(1, Number(e.target.value) || 50) })}
          />
          <span className="faint">MB</span>
        </div>
        <label>Safety</label>
        <label className="check">
          <input type="checkbox" checked={s.confirmDiscard} onChange={(e) => s.set({ confirmDiscard: e.target.checked })} /> Ask before discarding changes
        </label>
        <label>Graph</label>
        <label className="check">
          <input type="checkbox" checked={s.showRemoteBranchesInGraph} onChange={(e) => s.set({ showRemoteBranchesInGraph: e.target.checked })} /> Show remote branch labels
        </label>
      </div>
      {root && <SigningSettings root={root} />}
      <ShortcutSettings />
      <UpdateSettings />
      <div className="section-title">Git</div>
      <div className="settings-grid">
        <label>Git</label>
        <div className="vstack" style={{ gap: 3 }}>
          {gitErr && <span style={{ color: "var(--red)" }}>{gitErr}</span>}
          {sel && (
            <>
              <span className="hstack" style={{ gap: 8 }}>
                <b>{sel.source === "none" ? "Not found" : `git ${sel.version}`}</b>
                {sel.tooOld && <span className="pill amber">older than {sel.minVersion}</span>}
                <button type="button" className="btn sm ghost" onClick={redetect}>
                  Detect again
                </button>
              </span>
              {sel.path && (
                <span className="mono faint ellipsis" style={{ fontSize: "var(--fs-xs)" }} title={sel.path}>
                  {sel.path}
                </span>
              )}
            </>
          )}
        </div>
        <label>Identity</label>
        <div>
          <button type="button" className="btn sm" disabled={!root} onClick={() => root && identityDialog(root)}>
            <UserRound size={13} /> Edit name & email
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function discardDialog(paths: string[]): Promise<boolean> {
  return confirmDialog({
    title: paths.length === 1 ? "Discard changes?" : `Discard changes in ${paths.length} files?`,
    message: "Your edits will be removed from the working tree. A backup copy is kept in .git/revqora/trash.",
    confirm: "Discard",
    danger: true,
    icon: <Trash2 size={18} />,
    details: paths.slice(0, 30),
  });
}

function SigningSettings({ root }: { root: string }) {
  const [cfg, setCfg] = useState<SigningConfig | null>(null);
  useEffect(() => {
    api.signingGet(root).then(setCfg, () => {});
  }, [root]);
  if (!cfg) return null;
  const save = async (global: boolean) => {
    try {
      await api.signingSet(root, cfg, global);
      toast.success(global ? "Signing settings saved for all repositories" : "Signing settings saved for this repository");
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <>
      <div className="section-title">Commit signing</div>
      <div className="settings-grid">
        <label>Sign by default</label>
        <div className="hstack" style={{ gap: 14 }}>
          <label className="check">
            <input type="checkbox" checked={cfg.signCommits} onChange={(e) => setCfg({ ...cfg, signCommits: e.target.checked })} /> Commits
          </label>
          <label className="check">
            <input type="checkbox" checked={cfg.signTags} onChange={(e) => setCfg({ ...cfg, signTags: e.target.checked })} /> Tags
          </label>
        </div>
        <label>Format</label>
        <div className="seg">
          {(["openpgp", "ssh", "x509"] as const).map((f) => (
            <button type="button" key={f} className={cfg.format === f ? "on" : ""} onClick={() => setCfg({ ...cfg, format: f })}>
              {f === "openpgp" ? "GPG" : f === "ssh" ? "SSH key" : "X.509"}
            </button>
          ))}
        </div>
        <label>Signing key</label>
        <input
          className="input mono"
          value={cfg.key ?? ""}
          placeholder={cfg.format === "ssh" ? "~/.ssh/id_ed25519.pub" : "GPG key id, e.g. 3AA5C34371567BD2"}
          onChange={(e) => setCfg({ ...cfg, key: e.target.value })}
        />
        <label />
        <div className="hstack">
          <button type="button" className="btn sm" onClick={() => save(false)}>
            Save for this repository
          </button>
          <button type="button" className="btn sm ghost" onClick={() => save(true)}>
            Save globally
          </button>
        </div>
      </div>
    </>
  );
}

function ShortcutSettings() {
  const overrides = useSettings((s) => s.shortcuts);
  const set = useSettings((s) => s.set);
  const [capturing, setCapturing] = useState<string | null>(null);
  return (
    <>
      <div className="section-title">Keyboard shortcuts</div>
      <div className="settings-grid" style={{ gridTemplateColumns: "1fr auto auto", rowGap: 6 }}>
        {SHORTCUTS.map((sc) => {
          const cur = bindingFor(sc.id, overrides);
          return (
            <Fragment key={sc.id}>
              <label>{sc.label}</label>
              <button
                type="button"
                className={`btn sm ${capturing === sc.id ? "primary" : ""}`}
                style={{ minWidth: 150, fontFamily: "var(--font-code)" }}
                onClick={() => setCapturing(sc.id)}
                onKeyDown={(e) => {
                  if (capturing !== sc.id) return;
                  e.preventDefault();
                  e.stopPropagation();
                  if (e.key === "Escape") return setCapturing(null);
                  if (e.key === "Backspace" || e.key === "Delete") {
                    set({ shortcuts: { ...overrides, [sc.id]: "" } });
                    return setCapturing(null);
                  }
                  const combo = comboFromEvent(e);
                  if (!combo) return;
                  set({ shortcuts: { ...overrides, [sc.id]: combo } });
                  setCapturing(null);
                }}
                onBlur={() => setCapturing((c) => (c === sc.id ? null : c))}
              >
                {capturing === sc.id ? "Press keys…" : cur ? prettyCombo(cur) : "—"}
              </button>
              <button
                type="button"
                className="icon-btn sm"
                title="Reset to default"
                disabled={!(sc.id in overrides)}
                onClick={() => {
                  const next = { ...overrides };
                  delete next[sc.id];
                  set({ shortcuts: next });
                }}
              >
                <RotateCcw size={12} />
              </button>
            </Fragment>
          );
        })}
      </div>
    </>
  );
}
