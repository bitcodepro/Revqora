import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { List, FolderTree, Copy, CornerDownLeft, ExternalLink, FileText, FolderOpen, GitCommitHorizontal, History, Loader2, RotateCcw, ScanSearch, X } from "lucide-react";
import * as A from "../lib/actions";
import { api, errorMessage } from "../lib/api";
import type { Check, CommitDetails as Details, FileDiff, Signature } from "../lib/types";
import { CheckIcon, summarizeChecks } from "./PullRequests";
import { toast } from "../lib/ui";
import { absoluteTime, fullTime, joinPath, relativeTime, shortOid } from "../lib/format";
import { contextMenu, copyText, openOverlay, showDialog } from "../lib/ui";
import { Avatar, FileGroups, PathLabel, StatusIcon } from "./bits";
import { useRepos } from "../lib/store";
import { detailsKey, diffKey, loadDetails, loadDiff, peekDetails, peekDiff, previewGeneration, subscribePreview } from "../lib/commitPreview";
import { useSettings } from "../lib/settings";
import { DiffView, useDiffOpts } from "./DiffView";
import { jumpToCommit } from "./GraphView";
import { fileHistoryDialog } from "./FileHistory";
import { Splitter } from "./Overlays";
import { CommitMessageDialog } from "./CommitMessage";
import { useWorkspaceLayout } from "../lib/workspaceLayoutContext";

export function CommitDetails({ root, oid, onClose, compactMeta = false }: { root: string; oid: string; onClose?: () => void; compactMeta?: boolean }) {
  const generation = useSyncExternalStore(
    useCallback((listener) => subscribePreview(root, listener), [root]),
    useCallback(() => previewGeneration(root), [root]),
  );
  const remoteRefs = useRepos((s) => s.tabs[root]?.refs?.remote);
  const remoteVersion = useMemo(() => JSON.stringify((remoteRefs ?? []).map((r) => [r.fullName, r.oid]).sort((a, b) => a[0].localeCompare(b[0]))), [remoteRefs]);
  const detailKey = detailsKey(root, oid, remoteVersion);
  const [detailResult, setDetailResult] = useState<{ key: string; generation: number; value: Details } | null>(null);
  const d = peekDetails(detailKey, oid) ?? (detailResult?.key === detailKey && detailResult.generation === generation ? detailResult.value : null);
  const [detailError, setDetailError] = useState<{ key: string; generation: number; message: string } | null>(null);
  const err = detailError?.key === detailKey && detailError.generation === generation ? detailError.message : null;
  const [chosenFile, setFile] = useState<string | null>(null);
  const file = d ? (chosenFile && d.files.some((f) => f.path === chosenFile) ? chosenFile : d.files[0]?.path ?? null) : null;
  const [diffResult, setDiffResult] = useState<{ key: string; generation: number; value: FileDiff } | null>(null);
  const [diffError, setDiffError] = useState<{ key: string; generation: number; message: string } | null>(null);
  const [signatureResult, setSignatureResult] = useState<{ key: string; value: Signature } | null>(null);
  const signatureKey = JSON.stringify([root, oid, generation]);
  const sig = signatureResult?.key === signatureKey ? signatureResult.value : null;
  const [signatureBusy, setSignatureBusy] = useState(false);
  const signatureVersion = useRef(0);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [checksBusy, setChecksBusy] = useState(false);
  const [hasForge, setHasForge] = useState(false);
  const { mode, layout: { commitFilesWidth: filesWidth }, setLayout } = useWorkspaceLayout();
  const [fw, setFw] = useState(filesWidth);
  useEffect(() => setFw(filesWidth), [mode, filesWidth]);
  useEffect(() => {
    api.forgeInfo(root).then((f) => setHasForge(!!f), () => setHasForge(false));
  }, [root]);
  useEffect(() => setChecks(null), [oid]);
  const loadChecks = async () => {
    setChecksBusy(true);
    try {
      setChecks(await api.commitChecks(root, oid));
    } catch (e) {
      toast.error(e, "Could not load CI status");
    } finally {
      setChecksBusy(false);
    }
  };
  const diffOpts = useDiffOpts();
  const treeView = useSettings((s) => s.fileView) === "tree";

  useEffect(() => {
    let alive = true;
    const current = () => alive && previewGeneration(root) === generation;
    setDetailError(null);
    if (peekDetails(detailKey, oid)) return;
    // Skip transient selections while holding an arrow key or rapidly clicking.
    const timer = window.setTimeout(() => {
      if (!current()) return;
      void loadDetails(detailKey, root, oid).then(
        (value) => { if (current()) setDetailResult({ key: detailKey, generation, value }); },
        (e) => { if (current()) setDetailError({ key: detailKey, generation, message: errorMessage(e) }); },
      );
    }, 50);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [root, oid, detailKey, generation]);

  useEffect(() => {
    signatureVersion.current++; setSignatureResult(null); setSignatureBusy(false);
    return () => { signatureVersion.current++; };
  }, [signatureKey]);
  const verifySignature = async () => {
    const version = ++signatureVersion.current;
    setSignatureBusy(true);
    try {
      const value = await api.commitSignature(root, oid);
      if (version === signatureVersion.current) setSignatureResult({ key: signatureKey, value });
    } catch (e) { if (version === signatureVersion.current) toast.error(e, "Could not verify signature"); }
    finally { if (version === signatureVersion.current) setSignatureBusy(false); }
  };

  const selectedDiffKey = d && file ? diffKey(root, d.diffBase, d.oid, file, diffOpts) : null;
  const diff = selectedDiffKey ? peekDiff(selectedDiffKey, oid) ?? (diffResult?.key === selectedDiffKey && diffResult.generation === generation ? diffResult.value : null) : null;
  const diffErr = diffError?.key === selectedDiffKey && diffError.generation === generation ? diffError!.message : null;
  const diffLoading = !!selectedDiffKey && !diff && !diffErr;
  useEffect(() => {
    if (!d || !file || !selectedDiffKey || peekDiff(selectedDiffKey, oid)) return;
    let alive = true;
    const current = () => alive && previewGeneration(root) === generation;
    setDiffError(null);
    const timer = window.setTimeout(() => {
      if (!current()) return;
      void loadDiff(selectedDiffKey, root, d.diffBase, d.oid, file, diffOpts).then(
        (value) => { if (current()) setDiffResult({ key: selectedDiffKey, generation, value }); },
        (e) => { if (current()) setDiffError({ key: selectedDiffKey, generation, message: errorMessage(e) }); },
      );
    }, 30);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [root, d, file, oid, selectedDiffKey, diffOpts, generation]);

  // Alt+↑ / Alt+↓ step through the commit's files (handy in Review mode, works in Graph too).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || (e.key !== "ArrowDown" && e.key !== "ArrowUp") || !d?.files.length) return;
      if (document.querySelector(".modal-backdrop")) return;
      e.preventDefault();
      setFile((cur) => {
        const selected = cur && d.files.some((f) => f.path === cur) ? cur : file;
        const i = d.files.findIndex((f) => f.path === selected);
        const next = Math.max(0, Math.min(d.files.length - 1, (i < 0 ? -1 : i) + (e.key === "ArrowDown" ? 1 : -1)));
        return d.files[next].path;
      });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [d, file]);

  const current = d && d.oid.slice(0, oid.length) === oid.slice(0, d.oid.length) ? d : null;
  const header = (
    <header className="commit-preview-head">
      <div className="commit-heading">
        <h2 className="commit-subject selectable" title={current?.subject}>{current?.subject ?? "Commit preview"}</h2>
        {compactMeta && current && <div className="commit-byline">
          <span className="ellipsis" title={current.authorEmail}>{current.author}</span>
          <button type="button" className="hash-chip" title="Copy commit hash" onClick={() => copyText(current.oid, "Hash copied")}><GitCommitHorizontal size={12} /> {shortOid(current.oid)}</button>
          <span title={fullTime(current.authorTime)}>{relativeTime(current.authorTime)}</span>
        </div>}
      </div>
      <div className="commit-preview-actions">
        <button type="button" className="btn sm commit-message-open" disabled={!current} title="Read the full commit message" onClick={async () => {
          if (!current) return;
          const trigger = document.activeElement;
          await showDialog<void>((close) => <CommitMessageDialog subject={current.subject} body={current.body} oid={current.oid} author={current.author} onClose={() => close()} />);
          if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
        }}><FileText size={14} /> Message</button>
        {onClose && <button type="button" className="btn sm details-hide" title="Close commit preview" onClick={onClose}><X size={14} /> Close</button>}
      </div>
    </header>
  );
  if (err || !current || !d)
    return (
      <div className="commit-preview">
        {header}
        {err ? <div className="empty">{err}</div> : <div className="loading-center"><span className="loader" /></div>}
      </div>
    );

  const adds = d.files.reduce((a, f) => a + (f.additions ?? 0), 0);
  const dels = d.files.reduce((a, f) => a + (f.deletions ?? 0), 0);

  const metadata = (
    <div className="details-meta">
      <div className="hstack" style={{ gap: 10 }}>
        <Avatar name={d.author} email={d.authorEmail} large />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 600 }} className="ellipsis selectable">
            {d.author} <span className="faint" style={{ fontWeight: 400 }}>&lt;{d.authorEmail}&gt;</span>
          </div>
          <div className="faint" style={{ fontSize: "var(--fs-sm)" }} title={fullTime(d.authorTime)}>
            {relativeTime(d.authorTime)} · {absoluteTime(d.authorTime)}
          </div>
        </div>
      </div>
      <div className="meta-grid">
        <span className="k">Commit</span>
        <span>
          <span className="hash-chip" onClick={() => copyText(d.oid, "Hash copied")} title="Copy full hash">
            {d.oid.slice(0, 12)} <Copy size={11} />
          </span>
        </span>
        {d.parents.length > 0 && (
          <>
            <span className="k">{d.parents.length > 1 ? "Parents" : "Parent"}</span>
            <span className="hstack" style={{ gap: 6, flexWrap: "wrap" }}>
              {d.parents.map((p) => (
                <span key={p} className="hash-chip" onClick={() => jumpToCommit(root, p)} title="Go to parent">
                  {shortOid(p)} <GitCommitHorizontal size={11} />
                </span>
              ))}
            </span>
          </>
        )}
        {(d.committer !== d.author || d.commitTime !== d.authorTime) && (
          <>
            <span className="k">Committed</span>
            <span className="muted" title={fullTime(d.commitTime)}>
              {d.committer} · {relativeTime(d.commitTime)}
            </span>
          </>
        )}
        <span className="k">Signature</span>
        <span className="hstack" style={{ gap: 6 }}>
          {sig && <span title={[sig.signer, sig.key, sig.fingerprint].filter(Boolean).join("\n")}>
            {sig.status === "N" ? <span className="pill">Not signed</span> : <SignatureBadge sig={sig} />}
          </span>}
          <button type="button" className="btn sm ghost commit-signature-check" disabled={signatureBusy} onClick={() => void verifySignature()}>
            {signatureBusy && <Loader2 size={12} className="spin" />} {sig ? "Verify again" : "Verify signature"}
          </button>
        </span>
        {hasForge && d.containedInRemote && (
          <>
            <span className="k">CI</span>
            <span>
              {checks ? (
                <span className="hstack" style={{ gap: 6 }} title={checks.map((c) => `${c.state}: ${c.name}`).join("\n")}>
                  {summarizeChecks(checks) ? <CheckIcon state={summarizeChecks(checks)!} /> : null}
                  {checks.length ? `${checks.filter((c) => c.state === "success").length}/${checks.length} passed` : "no checks"}
                </span>
              ) : (
                <button className="btn sm ghost" onClick={loadChecks} disabled={checksBusy}>
                  {checksBusy ? <Loader2 size={12} className="spin" /> : null} Show CI status
                </button>
              )}
            </span>
          </>
        )}
        <span className="k">Status</span>
        <span>{d.containedInRemote ? <span className="pill green">pushed</span> : <span className="pill amber">local only</span>}</span>
      </div>
    </div>
  );

  return (
    <div className="commit-preview">
      {header}
      <div className="commit-details" style={{ ["--commit-files-w" as string]: `${fw}px` }}>
        <div className="details-left">
          {compactMeta ? <details className="commit-metadata"><summary>Commit details</summary>{metadata}</details> : metadata}
          <div className="file-list-head">
            <span>{d.files.length} files</span>
            <button
              className="icon-btn sm"
              style={{ marginLeft: "auto", order: 2 }}
              title={treeView ? "Flat list" : "Group by folder"}
              onClick={() => useSettings.getState().set({ fileView: treeView ? "list" : "tree" })}
            >
              {treeView ? <List size={12} /> : <FolderTree size={12} />}
            </button>
            <span className="stats" style={{ marginLeft: 0 }}>
              <span className="a">+{adds}</span>
              <span className="d">−{dels}</span>
            </span>
          </div>
          <div className="file-list">
            <FileGroups items={d.files} tree={treeView} idPrefix="c" render={(f, grouped) => (
              <div
                key={f.path}
                className={`file-row ${file === f.path ? "selected" : ""}`}
                onClick={() => setFile(f.path)}
                onContextMenu={(e) =>
                  contextMenu(e, [
                    { label: "File history", icon: <History size={14} />, onClick: () => fileHistoryDialog(root, f.path) },
                    {
                      label: "Restore this version into the working tree",
                      icon: <RotateCcw size={14} />,
                      disabled: f.status === "D",
                      onClick: () => A.act(root, () => api.checkoutFile(root, d.oid, f.path), { success: `${f.path} restored from ${shortOid(d.oid)}` }),
                    },
                    {
                      label: "Apply this file's changes to the working tree",
                      icon: <CornerDownLeft size={14} />,
                      onClick: () => A.act(root, () => api.applyFromCommit(root, d.diffBase, d.oid, f.path, null), { success: `Applied changes of ${f.path}` }),
                    },
                    { separator: true },
                    { label: "Blame at this commit", icon: <ScanSearch size={14} />, disabled: f.status === "D", onClick: () => openOverlay({ kind: "blame", root, path: f.path, rev: d.oid }) },
                    { label: "Open file", icon: <ExternalLink size={14} />, onClick: () => api.openPath(joinPath(root, f.path)) },
                    { label: "Show in folder", icon: <FolderOpen size={14} />, onClick: () => api.revealPath(joinPath(root, f.path)) },
                    { separator: true },
                    { label: "Copy path", icon: <Copy size={14} />, onClick: () => copyText(f.path, "Path copied") },
                  ])
                }
                title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
              >
                <StatusIcon code={f.status} />
                <PathLabel path={f.path} hideDir={grouped} />
                {!f.binary && (
                  <span className="stats">
                    {f.additions ? <span className="a">+{f.additions}</span> : null}
                    {f.deletions ? <span className="d">−{f.deletions}</span> : null}
                  </span>
                )}
              </div>
            )} />
          </div>
        </div>
        <Splitter dir="v" style={{ left: "clamp(140px, var(--commit-files-w), 45%)" }} onDrag={(d) => setFw((w) => Math.max(140, Math.min(600, w + d)))} onEnd={() => setLayout({ commitFilesWidth: fw })} />
        <DiffView
          diff={diff}
          loading={diffLoading}
          error={diffErr}
          mode="pick"
          onApply={async (selection) => {
            if (!file) return;
            await A.act(root, () => api.applyFromCommit(root, d.diffBase, d.oid, file, selection), { success: "Selected lines applied to the working tree", refresh: { status: true, layers: true } });
          }}
          path={file ?? ""}
          root={root}
          images={
            file
              ? {
                  old: d.diffBase ? { rev: `${d.diffBase}:${d.files.find((f) => f.path === file)?.oldPath ?? file}` } : null,
                  new: { rev: `${d.oid}:${file}` },
                }
              : undefined
          }
          emptyText={d.files.length ? "Select a file" : "This commit has no file changes"} />
      </div>
    </div>
  );
}

function SignatureBadge({ sig }: { sig: Signature }) {
  const who = sig.signer || sig.key;
  switch (sig.status) {
    case "G":
      return <span className="pill green">Verified{who ? ` · ${who}` : ""}</span>;
    case "U":
      return <span className="pill amber">Signed, key not trusted{who ? ` · ${who}` : ""}</span>;
    case "B":
      return <span className="pill red">Bad signature</span>;
    case "X":
    case "Y":
      return <span className="pill amber">Signed, expired</span>;
    case "R":
      return <span className="pill red">Signed with a revoked key</span>;
    default:
      return <span className="pill">Signed — cannot verify here</span>;
  }
}
