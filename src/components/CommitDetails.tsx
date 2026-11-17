import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { openRepoFile } from "../lib/openFile";
import { Columns2, SquarePen, Ellipsis, List, FolderTree, Copy, CornerDownLeft, ExternalLink, FileText, FolderOpen, GitCommitHorizontal, History, Loader2, RotateCcw, ScanSearch, X } from "lucide-react";
import * as A from "../lib/actions";
import { api, errorMessage } from "../lib/api";
import type { Check, CommitDetails as Details, FileDiff, GraphRow, RefLabel, Signature } from "../lib/types";
import { CheckIcon, summarizeChecks } from "./PrChecks";
import { toast } from "../lib/ui";
import { absoluteTime, fullTime, joinPath, relativeTime, shortOid } from "../lib/format";
import { contextMenu, copyText, openOverlay, showDialog } from "../lib/ui";
import { Avatar, FileGroups, PathLabel, StatusIcon } from "./bits";
import { useRepos } from "../lib/store";
import { containmentKey, detailsKey, diffKey, loadContainment, loadDetails, loadDiff, peekContainment, peekDetails, peekDiff, previewGeneration, subscribePreview } from "../lib/commitPreview";
import { useSettings } from "../lib/settings";
import { DiffView, useDiffOpts } from "./DiffView";
import { jumpToCommit } from "./GraphView";
import { fileHistoryDialog } from "./FileHistory";
import { Splitter } from "./Overlays";
import { CommitMessageDialog } from "./CommitMessage";
import { useWorkspaceLayout } from "../lib/workspaceLayoutContext";
import { useFileListNavigation } from "../lib/useFileListNavigation";
import { usePanelTitleMenu } from "./PanelWindows";
import { fileCopyMenu } from "./NamePathMenu";
import { commitMenu } from "./menus";
import { openInDiffTool, openInEditor } from "../lib/externalTools";
import { folderHistoryDialog } from "./HistoryDialogs";
import { CommitNote, prefetchNote } from "./CommitNote";

export function CommitDetails({ root, oid, onClose, compactMeta = false }: { root: string; oid: string; onClose?: () => void; compactMeta?: boolean }) {
  const fileNavigation = useFileListNavigation();
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
  const lastFile = useRef<{ key: string; path: string } | null>(null);
  useLayoutEffect(() => { if (file) lastFile.current = { key: detailKey, path: file }; }, [detailKey, file]);
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
  const preferredWidth = useRef(filesWidth);
  const filePane = useRef<HTMLDivElement>(null);
  const panelMenu = usePanelTitleMenu("commit");
  useLayoutEffect(() => { preferredWidth.current = filesWidth; setFw(filesWidth); }, [mode, filesWidth]);
  useEffect(() => {
    api.forgeInfo(root).then((f) => setHasForge(!!f), () => setHasForge(false));
  }, [root]);
  // The commit shown now: a slow CI answer for a commit the user has left is dropped.
  const shownCommit = useRef(`${root}
${oid}`);
  shownCommit.current = `${root}
${oid}`;
  useEffect(() => { setChecks(null); setChecksBusy(false); }, [root, oid]);
  const loadChecks = async () => {
    const asked = `${root}
${oid}`;
    setChecksBusy(true);
    try {
      const result = await api.commitChecks(root, oid);
      if (shownCommit.current === asked) setChecks(result);
    } catch (e) {
      if (shownCommit.current === asked) toast.error(e, "Could not load CI status");
    } finally {
      if (shownCommit.current === asked) setChecksBusy(false);
    }
  };
  const diffOpts = useDiffOpts(file);
  const treeView = useSettings((s) => s.fileView) === "tree";

  useEffect(() => {
    let alive = true;
    const current = () => alive && previewGeneration(root) === generation;
    setDetailError(null);
    if (peekDetails(detailKey, oid)) return;
    // Skip transient selections while holding an arrow key or rapidly clicking.
    const timer = window.setTimeout(() => {
      if (!current()) return;
      prefetchNote(root, oid);
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

  // Remote containment arrives after the header and file list. null = still unknown.
  const containKey = d ? containmentKey(root, d.oid, remoteVersion) : null;
  const [containResult, setContainResult] = useState<{ key: string; generation: number; value: boolean | "failed" } | null>(null);
  const containLoaded = containResult && containResult.key === containKey && containResult.generation === generation ? containResult.value : null;
  const containFailed = containLoaded === "failed";
  const contained: boolean | null = !d || !containKey ? null : d.containedInRemote ?? peekContainment(containKey) ?? (typeof containLoaded === "boolean" ? containLoaded : null);
  const [actionsBusy, setActionsBusy] = useState(false);
  useEffect(() => {
    if (!d || !containKey || d.containedInRemote != null || peekContainment(containKey) !== undefined) return;
    let alive = true;
    const current = () => alive && previewGeneration(root) === generation;
    void loadContainment(containKey, root, d.oid).then(
      (value) => { if (current()) setContainResult({ key: containKey, generation, value }); },
      () => { if (current()) setContainResult({ key: containKey, generation, value: "failed" }); },
    );
    return () => { alive = false; };
  }, [root, d, containKey, generation]);

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

  const current = d && d.oid.slice(0, oid.length) === oid.slice(0, d.oid.length) ? d : null;
  const header = (
    <header className="commit-preview-head" onContextMenu={panelMenu}>
      <div className="commit-heading">
        <h2 className="commit-subject selectable" title={current?.subject}>{current?.subject ?? "Commit preview"}</h2>
        {compactMeta && current && <div className="commit-byline">
          <span className="ellipsis" title={current.authorEmail}>{current.author}</span>
          <button type="button" className="hash-chip" title="Copy commit hash" onClick={() => copyText(current.oid, "Hash copied")}><GitCommitHorizontal size={12} /> {shortOid(current.oid)}</button>
          <span title={fullTime(current.authorTime)}>{relativeTime(current.authorTime)}</span>
        </div>}
      </div>
      <div className="commit-preview-actions">
        <button type="button" className="btn sm commit-message-open" disabled={!current} title="Read the full commit message" onClick={async (event) => {
          if (!current) return;
          const trigger = event.currentTarget;
          await showDialog<void>((close) => <CommitMessageDialog subject={current.subject} body={current.body} oid={current.oid} author={current.author} onClose={() => close()} />);
          if (trigger.isConnected) trigger.focus({ preventScroll: true });
        }}><FileText size={14} /> Message</button>
        {current && <CommitNote root={root} oid={current.oid} />}
        <button type="button" className="btn sm" disabled={!current || actionsBusy} aria-haspopup="menu" title="Commit actions: cherry-pick, revert, branch, tag, reset and more" onClick={async (event) => {
          if (!current) return;
          const trigger = event.currentTarget;
          const asked = shownCommit.current;
          // The menu states whether the commit is already pushed: wait for a fresh answer
          // instead of presenting an unknown state as "local only".
          let pushed = contained;
          if (pushed === null && containKey && !containFailed) {
            setActionsBusy(true);
            try { pushed = await loadContainment(containKey, root, current.oid); } catch { pushed = null; } finally { setActionsBusy(false); }
            if (shownCommit.current !== asked || !trigger.isConnected) return;
          }
          const box = trigger.getBoundingClientRect();
          const row = detailsRow(root, current, pushed);
          // Unknown is not "local only": keep the rewrite warning, worded for an unknown answer.
          contextMenu({ clientX: box.left, clientY: box.bottom + 4, currentTarget: trigger, preventDefault: () => {} }, commitMenu(root, row, [row], { publicationUnknown: pushed !== true && pushed !== false }));
        }}>{actionsBusy ? <Loader2 size={14} className="spin" /> : <Ellipsis size={14} />} Actions</button>
        {onClose && <button type="button" className="btn sm details-hide" title="Close commit preview" onClick={onClose}><X size={14} /> Close</button>}
      </div>
    </header>
  );
  const splitter = <Splitter dir="v" style={{ left: "clamp(140px, var(--commit-files-w), 45%)" }}
    onStart={() => { preferredWidth.current = filePane.current?.getBoundingClientRect().width ?? filesWidth; }}
    onDrag={delta => {
      preferredWidth.current = Math.max(140, Math.min(600, preferredWidth.current + delta));
      setFw(preferredWidth.current);
    }}
    onCommit={() => setLayout({ commitFilesWidth: Math.round(preferredWidth.current) })} />;
  if (err || !current || !d)
    return (
      <div className="commit-preview">
        {header}
        <div className="commit-details" style={{ ["--commit-files-w" as string]: `${fw}px` }}>
          <div ref={filePane} className="details-left">{err ? <div className="empty">{err}</div> : <div className="loading-center"><span className="loader" /></div>}</div>
          {splitter}
          {/* Keep the viewer mounted across refreshes: its search field/query
              survive while stale metadata/diff and mutation actions are absent. */}
          <DiffView diff={null} loading={!err} mode="pick" path={lastFile.current?.key === detailKey ? lastFile.current.path : ""} root={root} />
        </div>
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
        {hasForge && contained === true && (
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
        <span>{contained === true ? <span className="pill green">pushed</span>
          : contained === false ? <span className="pill amber">local only</span>
          : containFailed ? <span className="pill" title="Remote branches could not be checked for this commit.">unknown</span>
          : <span className="pill" title="Checking whether a remote branch contains this commit">checking…</span>}</span>
      </div>
    </div>
  );

  return (
    <div className="commit-preview">
      {header}
      <div className="commit-details" style={{ ["--commit-files-w" as string]: `${fw}px` }}>
        <div ref={filePane} className="details-left">
          {compactMeta ? <details className="commit-metadata"><summary>Commit details</summary>{metadata}</details> : metadata}
          <div className="file-list-head">
            <span>{d.files.length} files</span>
            <button aria-label={treeView ? "Flat list" : "Group by folder"}
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
          <div className="file-list" {...fileNavigation} aria-label="Commit files">
            <FileGroups items={d.files} tree={treeView} idPrefix="c" onFolderMenu={(e, folder) => contextMenu(e, [{ label: "Folder history…", icon: <History size={14} />, onClick: () => void folderHistoryDialog(root, folder) }])} render={(f, grouped) => (
              <div
                key={f.path}
                className={`file-row ${file === f.path ? "selected" : ""}`}
                data-file-nav=""
                data-file-path={f.path}
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
                    { label: "Open file", icon: <ExternalLink size={14} />, onClick: () => void openRepoFile(joinPath(root, f.path)) },
                    { label: "Open in editor", icon: <SquarePen size={14} />, disabled: f.status === "D", onClick: () => void openInEditor(root, f.path) },
                    { label: "Compare in external diff tool", icon: <Columns2 size={14} />, onClick: () => void openInDiffTool(root, f.path, "commits", d.diffBase, d.oid) },
                    { label: "Show in folder", icon: <FolderOpen size={14} />, onClick: () => api.revealPath(joinPath(root, f.path)) },
                    { separator: true },
                    ...fileCopyMenu(f.path),
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
        {splitter}
        <DiffView
          diff={diff}
          loading={diffLoading}
          error={diffErr}
          mode="pick"
          onApply={async (selection) => {
            if (!file || !diff || diffLoading || diffErr) return;
            await A.act(root, () => api.applyFromCommit(root, d.diffBase, d.oid, file, selection, diffOpts, diff.hash), { success: "Selected lines applied to the working tree", refresh: { status: true, layers: true } });
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

/** The commit as a history row, for the same actions as its History context menu. */
/** `pushed` null means the remote-containment answer is unknown; the row is then treated as published. */
function detailsRow(root: string, d: Details, pushed: boolean | null): GraphRow {
  const tab = useRepos.getState().tabs[root];
  const refs: RefLabel[] = [
    ...(tab?.refs?.local ?? []).filter((b) => b.oid === d.oid).map((b): RefLabel => ({ name: b.name, kind: "local", syncedRemote: null })),
    ...(tab?.refs?.remote ?? []).filter((b) => b.oid === d.oid).map((b): RefLabel => ({ name: b.name, kind: "remote", syncedRemote: null })),
    ...(tab?.refs?.tags ?? []).filter((t) => t.target === d.oid || t.oid === d.oid).map((t): RefLabel => ({ name: t.name, kind: "tag", syncedRemote: null })),
  ];
  return {
    index: -1, oid: d.oid, parents: d.parents, author: d.author, email: d.authorEmail, authorTime: d.authorTime,
    committer: d.committer, commitTime: d.commitTime, subject: d.subject, refs, col: 0, color: 0, laneId: 0, segs: [],
    isHead: tab?.info?.head.oid === d.oid, isMerge: d.parents.length > 1, localOnly: pushed === false, incoming: false,
  };
}
