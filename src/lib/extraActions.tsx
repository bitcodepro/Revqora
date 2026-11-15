import { worktreeCreateDialog, worktreeRemoveDialog, worktreePruneDialog, worktreeLockDialog } from "../components/WorktreeManager";
// Actions for submodules, worktrees, bisect and Git LFS.
import { useEffect, useState } from "react";
import { HardDrive, Package } from "lucide-react";
import { errorMessage } from "./api";
import { api, newOpId } from "./api";
import { useRepos } from "./store";
import { endBusy, showDialog, startBusy, toast } from "./ui";
import { act } from "./actions";
import type { LfsLock, LfsFile } from "./types";
import { Modal } from "../components/Modal";
import { confirmDialog, promptDialog } from "../components/dialogs";
import { shortOid } from "./format";

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

// ───────────── reviewed worktrees ─────────────
export const addWorktree = (root: string) => worktreeCreateDialog(root);
export const removeWorktree = (root: string, path: string) => worktreeRemoveDialog(root, path);
export const pruneWorktrees = (root: string) => worktreePruneDialog(root);
export const lockWorktree = (root: string, path: string, lock: boolean) => worktreeLockDialog(root, path, lock);

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
  const [locks, setLocks] = useState<LfsLock[] | null>(null);
  const [lockError, setLockError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const loadLocks = () => {
    setLockError(null);
    api.lfsLocks(root).then(setLocks, (e) => { setLocks([]); setLockError(errorMessage(e)); });
  };
  useEffect(() => {
    api.lfsFiles(root).then(setFiles, (e) => {
      toast.error(e);
      setFiles([]);
    });
    loadLocks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);
  const lockOf = (path: string) => locks?.find((l) => l.path === path) ?? null;
  const run = async (path: string, f: () => Promise<unknown>, done: string) => {
    setBusy(path);
    try { await f(); toast.success(done, path); loadLocks(); }
    catch (e) { toast.error(e, "Git LFS lock"); }
    finally { setBusy(null); }
  };
  /** Releases a lock; if the server refuses (someone else's lock), offers a force release. */
  const unlock = (lock: LfsLock) => run(lock.path, () => api.lfsUnlock(root, lock.path, false).catch(async (e) => {
    const forced = await confirmDialog({
      title: "Force unlock?",
      message: `${errorMessage(e)}

Force-release the lock on ${lock.path}${lock.owner ? ` held by ${lock.owner}` : ""}? They may lose work if they are editing it.`,
      confirm: "Force unlock",
      danger: true,
    });
    if (!forced) throw e;
    return api.lfsUnlock(root, lock.path, true);
  }), "Lock released");
  return (
    <Modal title="Git LFS files" icon={<HardDrive size={18} />} wide onClose={close} footer={<><button type="button" className="btn" onClick={loadLocks}>Refresh locks</button><button type="button" className="btn" onClick={close}>Close</button></>}>
      {lockError && <div className="faint" role="status" style={{ marginBottom: 6 }}>Locks are not available: {lockError}</div>}
      <div style={{ maxHeight: "55vh", overflow: "auto", margin: "0 -8px" }}>
        {!files && <div className="loading-center">Loading…</div>}
        {files?.length === 0 && <div className="empty">No LFS files</div>}
        {files?.map((f) => {
          const lock = lockOf(f.path);
          return (
            <div className="reflog-row" key={f.path} style={{ gridTemplateColumns: "90px 1fr auto auto auto" }}>
              <span className="mono faint">{f.oid}</span>
              <span className="ellipsis">{f.path}</span>
              {f.downloaded ? <span className="pill green">downloaded</span> : <span className="pill amber">pointer only</span>}
              {lock ? <span className="pill" title={lock.lockedAt}>locked{lock.owner ? ` by ${lock.owner}` : ""}</span> : <span />}
              {locks && !lockError && (lock
                ? <button type="button" className="btn sm" disabled={busy === f.path} onClick={() => void unlock(lock)}>Unlock</button>
                : <button type="button" className="btn sm" disabled={busy === f.path} onClick={() => void run(f.path, () => api.lfsLock(root, f.path), "File locked")}>Lock</button>)}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}
