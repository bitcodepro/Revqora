import { rebaseResultDialog } from "./RebaseResult";
import { validationDialog } from "./ConflictValidation";
import { repositoryFiles } from "./RepositoryFiles";
import { useEffect, useState } from "react";
import { open as openFile, save as saveFile } from "@tauri-apps/plugin-dialog";
import { Archive, FileDiff, GitBranch, History, Loader2, Undo2, Wrench, Zap } from "lucide-react";
import { Modal } from "./Modal";
import { api, newOpId } from "../lib/api";
import { useRepos } from "../lib/store";
import { endBusy, showDialog, startBusy, toast } from "../lib/ui";
import { act, handleOutcome, resetTo, createBranch } from "../lib/actions";
import type { DeletedBranch, RefLogEntry, RepoSize } from "../lib/types";
import { absoluteTime, relativeTime, shortOid } from "../lib/format";

const kib = (n: number) => (n < 1024 ? `${n} KB` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} MB` : `${(n / 1024 / 1024).toFixed(2)} GB`);

export function repoToolsDialog(root: string, tab: "overview" | "deleted" = "overview") {
  return showDialog<void>((close) => <RepoToolsBody root={root} initial={tab} close={close} />);
}

function RepoToolsBody({ root, initial, close }: { root: string; initial: "overview" | "deleted"; close: () => void }) {
  const [tab, setTab] = useState(initial);
  const [size, setSize] = useState<RepoSize | null>(null);
  const [deleted, setDeleted] = useState<DeletedBranch[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const reload = () => {
    api.repoSize(root).then(setSize, (e) => toast.error(e));
    api.deletedBranches(root).then(setDeleted, () => setDeleted([]));
  };
  useEffect(reload, [root]);

  const task = async (t: "gc" | "prune" | "repack" | "maintenance-start" | "maintenance-stop", label: string) => {
    const id = newOpId();
    setBusy(t);
    startBusy(id, label);
    try {
      await api.maintenanceRun(root, t, id);
      toast.success(`${label} done`);
    } catch (e) {
      toast.error(e, `${label} failed`);
    } finally {
      endBusy(id);
      setBusy(null);
      reload();
    }
  };
  const writeGraph = async () => {
    const id = newOpId();
    setBusy("cg");
    startBusy(id, "Writing commit-graph");
    try {
      await api.commitGraphWrite(root, id);
      toast.success("Commit-graph written");
    } catch (e) {
      toast.error(e);
    } finally {
      endBusy(id);
      setBusy(null);
      reload();
    }
  };

  return (
    <Modal
      title="Repository tools"
      icon={<Wrench size={18} />}
      wide
      onClose={close}
      footer={
        <button type="button" className="btn" onClick={close}>
          Close
        </button>
      }
    >
      <div className="studio-actions"><button className="btn" onClick={() => { close(); void rebaseResultDialog(root); }}>Rebase Studio result</button><button className="btn" onClick={() => { close(); void validationDialog(root); }}>Validate / conflict drafts</button><button className="btn" onClick={() => { close(); void repositoryFiles(root, "ignored"); }}>Ignored files</button><button className="btn" onClick={() => { close(); void repositoryFiles(root, "nested"); }}>Nested repositories</button></div>
      <div className="seg" style={{ alignSelf: "flex-start" }}>
        <button type="button" className={tab === "overview" ? "on" : ""} onClick={() => setTab("overview")}>
          Housekeeping
        </button>
        <button type="button" className={tab === "deleted" ? "on" : ""} onClick={() => setTab("deleted")}>
          Recently deleted branches {deleted?.length ? `(${deleted.length})` : ""}
        </button>
      </div>
      {tab === "overview" && (
        <>
          {!size ? (
            <div className="loading-center" style={{ minHeight: 120 }}>
              <span className="loader" />
            </div>
          ) : (
            <div className="settings-grid">
              <label>Packed objects</label>
              <span>
                {kib(size.packSizeKib)} in {size.packs} pack{size.packs === 1 ? "" : "s"}
              </span>
              <label>Loose objects</label>
              <span>
                {size.looseObjects.toLocaleString()} ({kib(size.looseSizeKib)}){size.looseObjects > 5000 ? <span className="pill amber" style={{ marginLeft: 8 }}>run gc</span> : null}
              </span>
              <label>Commit-graph</label>
              <span>{size.commitGraph ? <span className="pill green">present</span> : <span className="pill">not written</span>}</span>
              <label>Background maintenance</label>
              <span>{size.maintenanceRegistered ? <span className="pill green">scheduled</span> : <span className="pill">off</span>}</span>
            </div>
          )}
          <div className="hstack" style={{ flexWrap: "wrap" }}>
            <button type="button" className="btn" disabled={!!busy} onClick={() => task("gc", "Garbage collection")}>
              {busy === "gc" ? <Loader2 size={14} className="spin" /> : <Archive size={14} />} Run gc
            </button>
            <button type="button" className="btn" disabled={!!busy} onClick={() => task("repack", "Repack")}>
              Repack
            </button>
            <button type="button" className="btn" disabled={!!busy} onClick={() => task("prune", "Prune")}>
              Prune unreachable
            </button>
            <button type="button" className="btn" disabled={!!busy || size?.commitGraph} onClick={writeGraph}>
              <Zap size={14} /> Write commit-graph
            </button>
            {size?.maintenanceRegistered ? (
              <button type="button" className="btn" disabled={!!busy} onClick={() => task("maintenance-stop", "Stop background maintenance")}>
                Stop background maintenance
              </button>
            ) : (
              <button type="button" className="btn" disabled={!!busy} onClick={() => task("maintenance-start", "Background maintenance")}>
                Schedule background maintenance
              </button>
            )}
          </div>
          <div className="callout">
            <FileDiff size={15} />
            <div className="hstack" style={{ flex: 1, justifyContent: "space-between" }}>
              <span>Apply commits or changes from a .patch / .diff file.</span>
              <button
                type="button"
                className="btn sm"
                onClick={async () => {
                  close();
                  await applyPatchFile(root);
                }}
              >
                Apply patch file…
              </button>
            </div>
          </div>
        </>
      )}
      {tab === "deleted" && (
        <div style={{ maxHeight: "50vh", overflow: "auto", margin: "0 -8px" }}>
          {!deleted && <div className="loading-center">Loading…</div>}
          {deleted?.length === 0 && <div className="empty">No deleted branches found.</div>}
          {deleted?.map((b) => (
            <div className="reflog-row" key={b.name + b.oid} style={{ gridTemplateColumns: "1fr 1.4fr 110px auto" }}>
              <span className="hstack" style={{ gap: 6, minWidth: 0 }}>
                <GitBranch size={13} />
                <b className="ellipsis">{b.name}</b>
              </span>
              <span className="ellipsis faint" title={b.subject}>
                {shortOid(b.oid)} {b.subject}
              </span>
              <span className="faint" title={absoluteTime(b.time)}>
                {relativeTime(b.time)}
              </span>
              <button
                type="button"
                className="btn sm"
                onClick={async () => {
                  await act(root, () => api.restoreBranch(root, b.name, b.oid), { success: `Restored ${b.name}` });
                  reload();
                }}
              >
                <Undo2 size={12} /> Restore
              </button>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

export async function applyPatchFile(root: string) {
  const file = await openFile({ title: "Apply a patch", filters: [{ name: "Patches", extensions: ["patch", "diff", "mbox", "eml"] }, { name: "All files", extensions: ["*"] }] });
  if (typeof file !== "string") return;
  const out = await act(root, () => api.applyPatch(root, file), { busy: "Applying patch" });
  if (out && out.status !== "done") handleOutcome(root, out, "Apply patch");
  else if (out) toast.success(out.message);
}

export async function savePatch(root: string, oids: string[], name: string) {
  const file = await saveFile({ title: "Save patch", defaultPath: `${name.replace(/[^\w.-]+/g, "-").slice(0, 60) || "changes"}.patch`, filters: [{ name: "Patch", extensions: ["patch"] }] });
  if (!file) return;
  try {
    const n = await api.createPatch(root, oids, file);
    toast.success(`Saved ${n} commit${n === 1 ? "" : "s"} as a patch`, file);
  } catch (e) {
    toast.error(e);
  }
}

export function branchReflogDialog(root: string, name: string) {
  return showDialog<void>((close) => <BranchReflogBody root={root} name={name} close={close} />);
}

function BranchReflogBody({ root, name, close }: { root: string; name: string; close: () => void }) {
  const [items, setItems] = useState<RefLogEntry[] | null>(null);
  useEffect(() => {
    api.branchReflog(root, name).then(setItems, (e) => {
      toast.error(e);
      setItems([]);
    });
  }, [root, name]);
  const current = useRepos.getState().tabs[root]?.info?.head.branch;
  return (
    <Modal title={`History of ${name}`} subtitle="Every position this branch has pointed to." icon={<History size={18} />} wide onClose={close} footer={<button type="button" className="btn" onClick={close}>Close</button>}>
      <div style={{ maxHeight: "55vh", overflow: "auto", margin: "0 -8px" }}>
        {!items && <div className="loading-center">Loading…</div>}
        {items?.length === 0 && <div className="empty">No reflog for this branch.</div>}
        {items?.map((it, i) => (
          <div className="reflog-row" key={i} style={{ gridTemplateColumns: "80px 1fr 110px auto" }}>
            <span className="mono faint">{shortOid(it.oid)}</span>
            <span className="ellipsis">{it.message}</span>
            <span className="faint" title={absoluteTime(it.time)}>
              {relativeTime(it.time)}
            </span>
            <span className="hstack" style={{ gap: 4 }}>
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  close();
                  createBranch(root, it.oid, shortOid(it.oid));
                }}
              >
                New branch here
              </button>
              {current === name && (
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => {
                    close();
                    resetTo(root, it.oid, it.message);
                  }}
                >
                  Reset here…
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
    </Modal>
  );
}
