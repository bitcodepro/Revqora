import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Copy, GitCommitHorizontal, GitCompareArrows } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { act, handleOutcome, prepareOperation } from "../lib/actions";
import { shortOid } from "../lib/format";
import { getTab, useRepos } from "../lib/store";
import type { BranchCommitComparison, BranchInfo, RangeCommit } from "../lib/types";
import { contextMenu, copyText, showDialog } from "../lib/ui";
import { confirmDialog } from "./dialogs";
import { Modal } from "./Modal";

const branchName = (ref: string) => ref.replace(/^refs\/(heads|remotes)\//, "");
type ComparedBranch = { ref: string; oid: string };

export function branchCommitCompare(root: string, initialRef?: string) {
  const tab = getTab(root);
  const current = tab?.info?.head.branch ? `refs/heads/${tab.info.head.branch}` : "";
  const source = initialRef ?? (current || tab?.refs?.local[0]?.fullName || tab?.refs?.remote[0]?.fullName || "");
  return showDialog<void>((close) => <BranchCommitCompare root={root} initialFrom={source} initialTo={source === current ? "" : current} close={close} />);
}

function BranchSelect({ label, value, exclude, local, remote, disabled, change }: {
  label: string; value: string; exclude: string; local: BranchInfo[]; remote: BranchInfo[]; disabled: boolean; change: (value: string) => void;
}) {
  return <label className="branch-compare-select">
    <b>{label}</b>
    <select className="input" value={value} disabled={disabled} onChange={(event) => change(event.target.value)}>
      <option value="">Choose a branch…</option>
      {([["Local branches", local], ["Remote branches", remote]] as const).map(([group, branches]) => (
        <optgroup label={group} key={group}>
          {branches.map((branch) => <option key={branch.fullName} value={branch.fullName} disabled={branch.fullName === exclude}>{branch.name}</option>)}
        </optgroup>
      ))}
    </select>
  </label>;
}

function BranchCommitCompare({ root, initialFrom, initialTo, close }: { root: string; initialFrom: string; initialTo: string; close: () => void }) {
  const refs = useRepos((state) => state.tabs[root]?.refs);
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [request, setRequest] = useState<{ from: string; to: string } | null>(null);
  const [result, setResult] = useState<BranchCommitComparison | null>(null);
  const [error, setError] = useState("");
  const [picking, setPicking] = useState(false);
  const pickPending = useRef(false);
  const local = refs?.local ?? [];
  const remote = refs?.remote ?? [];
  const canCompare = from !== to && [from, to].every((ref) => local.some((branch) => branch.fullName === ref) || remote.some((branch) => branch.fullName === ref));

  useEffect(() => {
    if (!request) return;
    let current = true;
    api.compareBranchCommits(root, request.from, request.to).then(
      (value) => { if (current) setResult(value); },
      (error) => { if (current) setError(errorMessage(error)); },
    );
    return () => { current = false; };
  }, [request, root]);

  const clear = () => { setRequest(null); setResult(null); setError(""); };
  const compare = () => {
    if (!canCompare || pickPending.current) return;
    setResult(null); setError(""); setRequest({ from, to });
  };
  const loading = !!request && !result && !error;
  const closeComparison = () => { if (!pickPending.current) close(); };
  const pick = async (commit: RangeCommit, source: ComparedBranch, destination: ComparedBranch) => {
    if (pickPending.current || !destination.ref.startsWith("refs/heads/")) return;
    pickPending.current = true;
    setPicking(true);
    const name = branchName(destination.ref);
    try {
      const expectedState = await prepareOperation(root);
      if (!expectedState) return;
      const switching = getTab(root)?.info?.head.branch !== name;
      const confirmed = await confirmDialog({
        title: `Cherry-pick into ${name}?`,
        confirm: "Cherry-pick",
        icon: <GitCommitHorizontal size={18} />,
        message: switching ? `Revqora will switch to ${name} and apply this commit locally.` : `Apply this commit to ${name} locally.`,
        details: [`${commit.oid} · ${commit.subject || "(no commit message)"}`],
      });
      if (!confirmed) return;
      const outcome = await act(root, () => api.cherryPickComparedCommit(root, {
        source: source.ref, sourceOid: source.oid, destination: destination.ref, destinationOid: destination.oid, oid: commit.oid,
      }, expectedState), { busy: `Cherry-picking into ${name}` });
      handleOutcome(root, outcome, "Cherry-pick");
      if (outcome?.status === "conflicts" || outcome?.status === "stopped") close();
      else if (outcome) { setResult(null); setError(""); setRequest({ from, to }); }
    } finally {
      pickPending.current = false;
      setPicking(false);
    }
  };

  return <Modal title="Compare branch commits" subtitle="See which commits are present on each side." icon={<GitCompareArrows size={18} />} wide onClose={closeComparison} onSubmit={compare}
    footer={<><button type="button" className="btn" onClick={closeComparison} disabled={picking}>Close</button><button type="submit" className="btn primary" disabled={!canCompare || loading || picking}>Compare</button></>}>
    <div className="branch-compare-grid">
      <BranchSelect label="Branch A" value={from} exclude={to} local={local} remote={remote} disabled={picking} change={(value) => { setFrom(value); clear(); }} />
      <BranchSelect label="Compare with" value={to} exclude={from} local={local} remote={remote} disabled={picking} change={(value) => { setTo(value); clear(); }} />
    </div>
    {loading && <div role="status" className="hstack"><span className="loader" /> Comparing commits…</div>}
    {error && <div className="callout warn" role="alert">{error}</div>}
    {result && <>
      <p className="muted branch-compare-hint">Right-click a commit or drag it into the other branch to cherry-pick. Choose a local branch as the destination.</p>
      <div className="branch-compare-grid" data-branch-comparison>
        <CommitColumn branch={{ ref: from, oid: result.fromOid }} destination={{ ref: to, oid: result.toOid }} picking={picking} pick={pick}
          count={result.fromCount} initial={result.fromOnly} more={(offset) => api.branchCommitPage(root, result.toOid, result.fromOid, offset)} />
        <CommitColumn branch={{ ref: to, oid: result.toOid }} destination={{ ref: from, oid: result.fromOid }} picking={picking} pick={pick}
          count={result.toCount} initial={result.toOnly} more={(offset) => api.branchCommitPage(root, result.fromOid, result.toOid, offset)} />
      </div>
    </>}
  </Modal>;
}

function CommitColumn({ branch, destination, count, initial, more, picking, pick }: {
  branch: ComparedBranch; destination: ComparedBranch; count: number; initial: RangeCommit[];
  more: (offset: number) => Promise<RangeCommit[]>; picking: boolean;
  pick: (commit: RangeCommit, source: ComparedBranch, destination: ComparedBranch) => Promise<void>;
}) {
  const [commits, setCommits] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const name = branchName(branch.ref);
  const destinationName = branchName(destination.ref);
  const canPick = !picking && destination.ref.startsWith("refs/heads/");
  const drag = useRef<{ id: number; x: number; y: number; target: HTMLElement | null } | null>(null);
  const stopDrag = () => {
    drag.current?.target?.removeAttribute("data-cherry-pick-drop");
    drag.current = null;
  };
  useEffect(() => stopDrag, []);
  const dropTarget = (event: PointerEvent<HTMLElement>) => {
    const row = event.currentTarget;
    const target = row.ownerDocument.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-compared-branch]");
    return target?.dataset.comparedBranch === destination.ref && target.closest("[data-branch-comparison]") === row.closest("[data-branch-comparison]") ? target : null;
  };
  const next = async () => {
    setLoading(true); setError("");
    try {
      const page = await more(commits.length);
      const previous = new Set(commits.map((commit) => commit.oid));
      if (!page.length || page.some((commit) => previous.has(commit.oid))) {
        throw new Error("Commit history changed. Compare the branches again to refresh the results.");
      }
      setCommits([...commits, ...page]);
    } catch (error) { setError(errorMessage(error)); }
    finally { setLoading(false); }
  };
  return <section className="branch-compare-column" data-compared-branch={branch.ref} aria-label={`Only in ${name}`}>
    <header className="hstack"><b title={name}>Only in {name}</b><span className="pill accent">{count}</span><code title={branch.oid}>{shortOid(branch.oid)}</code></header>
    <div className="branch-compare-list">
      {!commits.length && <p className="batch-note">No unique commits.</p>}
      {commits.map((commit) => <article className="branch-compare-commit" key={commit.oid} data-draggable={canPick || undefined}
        onContextMenu={(event) => contextMenu(event, [
          { label: `Cherry-pick into ${destinationName}…`, icon: <GitCommitHorizontal size={14} />, disabled: !canPick,
            hint: destination.ref.startsWith("refs/heads/") ? undefined : "Choose a local branch",
            onClick: () => void pick(commit, branch, destination) },
          { label: "Copy SHA", icon: <Copy size={14} />, onClick: () => void copyText(commit.oid, "Hash copied") },
        ])}
        onPointerDown={(event) => {
          if (!canPick || event.button !== 0 || event.pointerType !== "mouse" || (event.target as Element).closest("button")) return;
          stopDrag();
          drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, target: null };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const active = drag.current;
          if (active?.id !== event.pointerId || Math.hypot(event.clientX - active.x, event.clientY - active.y) < 6) return;
          const target = dropTarget(event);
          if (target === active.target) return;
          active.target?.removeAttribute("data-cherry-pick-drop");
          target?.setAttribute("data-cherry-pick-drop", "");
          active.target = target;
        }}
        onPointerUp={(event) => {
          const active = drag.current;
          if (active?.id !== event.pointerId) return;
          const target = Math.hypot(event.clientX - active.x, event.clientY - active.y) >= 6 ? dropTarget(event) : null;
          stopDrag();
          if (canPick && target) void pick(commit, branch, destination);
        }}
        onPointerCancel={stopDrag}
        onLostPointerCapture={stopDrag}>
        <b>{commit.subject || "(no commit message)"}</b>
        <div className="hstack">
          <button type="button" className="btn sm mono" aria-label={`Copy SHA ${shortOid(commit.oid)}`} title={commit.oid} onClick={() => void copyText(commit.oid, "Hash copied")}><Copy size={12} /> {shortOid(commit.oid)}</button>
          <span className="faint">{commit.author} · <CommitTime seconds={commit.time} /></span>
        </div>
      </article>)}
      {error && <p className="batch-note amber" role="alert">{error}</p>}
      {commits.length < count && <div className="branch-compare-more"><button type="button" className="btn sm" disabled={loading} onClick={() => void next()}>{loading ? "Loading…" : `Load more (${commits.length} of ${count})`}</button></div>}
    </div>
  </section>;
}

const commitDateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

function CommitTime({ seconds }: { seconds: number }) {
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? <time dateTime={date.toISOString()}>{commitDateFormat.format(date)}</time> : <span>Unknown date</span>;
}
