// Actions for submodules, worktrees, bisect and Git LFS.
import { useEffect, useState } from "react";
import { open as openFolder } from "@tauri-apps/plugin-dialog";
import { FolderGit2, FolderOpen, HardDrive, Package } from "lucide-react";
import { api, isGitError, newOpId } from "./api";
import { getTab, useRepos } from "./store";
import { endBusy, showDialog, startBusy, toast } from "./ui";
import { act, prepareOperation } from "./actions";
import type { LfsFile } from "./types";
import { Modal } from "../components/Modal";
import { confirmDialog, promptDialog, validBranchName } from "../components/dialogs";
import { basename, shortOid } from "./format";

async function streamed(root: string, label: string, fn: (opId: string) => Promise<unknown>, success: string) {
  const id = newOpId();
  startBusy(id, label);
  try {
    await fn(id);
    toast.success(success);
  } catch (e) {
    toast.error(e, `${label} failed`);
  } finally {
    endBusy(id);
    await useRepos.getState().refresh(root);
  }
}

// ───────────── submodules ─────────────

export const updateSubmodules = (root: string, paths: string[] = []) =>
  streamed(root, paths.length ? `Updating ${paths[0]}` : "Updating submodules", (id) => api.submoduleUpdate(root, paths, id), "Submodules updated");

export async function addSubmodule(root: string) {
  const url = await promptDialog({ title: "Add submodule", label: "Repository URL", placeholder: "https://github.com/user/library.git", icon: <Package size={18} /> });
  if (!url) return;
  const guess = (url.trim().replace(/\/+$/, "").split(/[/:\\]/).pop() ?? "lib").replace(/\.git$/, "");
  const path = await promptDialog({ title: "Submodule folder", label: "Path inside this repository", initial: guess, icon: <Package size={18} /> });
  if (!path) return;
  await streamed(root, `Adding ${path}`, (id) => api.submoduleAdd(root, url, path, id), `Submodule ${path} added — commit to record it`);
}

// ───────────── worktrees ─────────────

export function addWorktree(root: string) {
  return showDialog<void>((close) => <WorktreeDialog root={root} close={close} />);
}

function WorktreeDialog({ root, close }: { root: string; close: () => void }) {
  const tab = getTab(root);
  const branches = tab?.refs?.local.filter((b) => !b.isHead).map((b) => b.name) ?? [];
  const [mode, setMode] = useState<"new" | "existing">(branches.length ? "existing" : "new");
  const [branch, setBranch] = useState(branches[0] ?? "");
  const [newBranch, setNewBranch] = useState("");
  const [start, setStart] = useState(tab?.info?.head.branch ?? "HEAD");
  const parent = root.replace(/[\\/][^\\/]+$/, "");
  const [path, setPath] = useState("");
  const name = mode === "new" ? newBranch : branch;
  useEffect(() => {
    if (name) setPath(`${parent}${root.includes("\\") ? "\\" : "/"}${basename(root)}-${name.replace(/[\\/]/g, "-")}`);
  }, [name, parent, root]);
  const err = mode === "new" && newBranch.trim() ? validBranchName(newBranch) : null;
  const ok = path.trim() && (mode === "existing" ? !!branch : !!newBranch.trim() && !err);
  const submit = async () => {
    if (!ok) return;
    const res = await act(root, () => api.worktreeAdd(root, path.trim(), mode === "existing" ? branch : null, mode === "new" ? newBranch.trim() : null, mode === "new" ? start : null).then(() => true), {
      success: `Worktree created at ${path.trim()}`,
    });
    if (res !== undefined) close();
  };
  return (
    <Modal
      title="New worktree"
      subtitle="A second working folder of this repository with another branch checked out."
      icon={<FolderGit2 size={18} />}
      onClose={close}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!ok}>
            Create worktree
          </button>
        </>
      }
    >
      <div className="seg" style={{ alignSelf: "flex-start" }}>
        <button type="button" className={mode === "existing" ? "on" : ""} disabled={!branches.length} onClick={() => setMode("existing")}>
          Existing branch
        </button>
        <button type="button" className={mode === "new" ? "on" : ""} onClick={() => setMode("new")}>
          New branch
        </button>
      </div>
      {mode === "existing" ? (
        <div className="field">
          <label>Branch</label>
          <select className="select" value={branch} onChange={(e) => setBranch(e.target.value)}>
            {branches.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
        </div>
      ) : (
        <>
          <div className="field">
            <label>New branch name</label>
            <input className="input mono" value={newBranch} placeholder="feature/x" onChange={(e) => setNewBranch(e.target.value)} />
            {err && <div className="err">{err}</div>}
          </div>
          <div className="field">
            <label>Start from</label>
            <input className="input mono" value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
        </>
      )}
      <div className="field">
        <label>Folder</label>
        <div className="hstack">
          <input className="input" value={path} onChange={(e) => setPath(e.target.value)} />
          <button
            type="button"
            className="btn"
            onClick={async () => {
              const d = await openFolder({ directory: true, title: "Parent folder for the worktree" });
              if (typeof d === "string") setPath(`${d}${d.includes("\\") ? "\\" : "/"}${basename(path) || name}`);
            }}
          >
            <FolderOpen size={14} />
          </button>
        </div>
      </div>
    </Modal>
  );
}

export async function removeWorktree(root: string, path: string) {
  const expectedState = await prepareOperation(root);
  if (!expectedState) return;
  let expectedTargetState: string | null;
  try { expectedTargetState = (await api.status(path)).stateToken ?? null; }
  catch (e) { toast.error(e); return; }
  const ok = await confirmDialog({ title: "Remove this worktree?", message: `The folder ${path} is deleted. Its branch and commits stay in the repository.`, confirm: "Remove", danger: true });
  if (!ok) return;
  try {
    await api.worktreeRemove(root, path, false, expectedState, expectedTargetState);
    toast.success("Worktree removed");
  } catch (e) {
    if (!isGitError(e) || e.kind !== "dirty-worktree") { toast.error(e); return; }
    const force = await confirmDialog({
      title: "The worktree has local changes",
      message: "Remove it anyway? Uncommitted changes in that folder will be lost.",
      confirm: "Remove anyway",
      danger: true,
    });
    if (force) await act(root, () => api.worktreeRemove(root, path, true, expectedState, expectedTargetState), { success: "Worktree removed" });
    else toast.error(e);
  }
  await useRepos.getState().refresh(root);
}

// ───────────── bisect ─────────────

export async function bisectStart(root: string, goodOid: string) {
  const ok = await confirmDialog({
    title: "Start bisect?",
    message: `Git will check out commits between ${shortOid(goodOid)} (good) and HEAD (bad) one by one. Test each one and mark it good or bad until the first bad commit is found.`,
    confirm: "Start bisect",
  });
  if (!ok) return;
  const st = await act(root, () => api.bisectStart(root, "HEAD", goodOid), { busy: "Starting bisect" });
  if (st) toast.info("Bisect started", st.message.split("\n")[0]);
}

export async function bisectMark(root: string, verdict: "good" | "bad" | "skip", rev?: string) {
  const st = await act(root, () => api.bisectMark(root, verdict, rev ?? null));
  if (st?.firstBad) toast.success("First bad commit found", `${shortOid(st.firstBad)} — reset bisect when you are done.`);
}

export async function bisectReset(root: string) {
  await act(root, () => api.bisectReset(root), { success: "Bisect finished — back on your branch" });
}

// ───────────── LFS ─────────────

export const lfsAction = (root: string, action: "pull" | "fetch" | "prune" | "install") =>
  streamed(root, `git lfs ${action}`, (id) => api.lfsRun(root, action, id), `git lfs ${action} done`);

export async function lfsTrack(root: string) {
  const pattern = await promptDialog({ title: "Track files with Git LFS", label: "Pattern", placeholder: "*.psd", help: "Files matching the pattern are stored in LFS from now on (.gitattributes is updated)." });
  if (pattern) await act(root, () => api.lfsTrack(root, pattern, true), { success: `Tracking ${pattern} with LFS` });
}

export const lfsUntrack = (root: string, pattern: string) => act(root, () => api.lfsTrack(root, pattern, false), { success: `${pattern} no longer tracked` });

export function lfsFilesDialog(root: string) {
  return showDialog<void>((close) => <LfsFilesBody root={root} close={close} />);
}

function LfsFilesBody({ root, close }: { root: string; close: () => void }) {
  const [files, setFiles] = useState<LfsFile[] | null>(null);
  useEffect(() => {
    api.lfsFiles(root).then(setFiles, (e) => {
      toast.error(e);
      setFiles([]);
    });
  }, [root]);
  return (
    <Modal title="Git LFS files" icon={<HardDrive size={18} />} wide onClose={close} footer={<button type="button" className="btn" onClick={close}>Close</button>}>
      <div style={{ maxHeight: "55vh", overflow: "auto", margin: "0 -8px" }}>
        {!files && <div className="loading-center">Loading…</div>}
        {files?.length === 0 && <div className="empty">No LFS files</div>}
        {files?.map((f) => (
          <div className="reflog-row" key={f.path} style={{ gridTemplateColumns: "90px 1fr auto" }}>
            <span className="mono faint">{f.oid}</span>
            <span className="ellipsis">{f.path}</span>
            {f.downloaded ? <span className="pill green">downloaded</span> : <span className="pill amber">pointer only</span>}
          </div>
        ))}
      </div>
    </Modal>
  );
}
