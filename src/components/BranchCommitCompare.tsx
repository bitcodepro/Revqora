import { useEffect, useState } from "react";
import { Copy, GitCompareArrows } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { shortOid } from "../lib/format";
import { getTab, useRepos } from "../lib/store";
import type { BranchCommitComparison, BranchInfo, RangeCommit } from "../lib/types";
import { copyText, showDialog } from "../lib/ui";
import { Modal } from "./Modal";

export function branchCommitCompare(root: string, initialRef?: string) {
  const tab = getTab(root);
  const current = tab?.info?.head.branch ? `refs/heads/${tab.info.head.branch}` : "";
  const source = initialRef ?? (current || tab?.refs?.local[0]?.fullName || tab?.refs?.remote[0]?.fullName || "");
  return showDialog<void>((close) => <BranchCommitCompare root={root} initialFrom={source} initialTo={source === current ? "" : current} close={close} />);
}

function BranchSelect({ label, value, exclude, local, remote, change }: {
  label: string; value: string; exclude: string; local: BranchInfo[]; remote: BranchInfo[]; change: (value: string) => void;
}) {
  return <label className="branch-compare-select">
    <b>{label}</b>
    <select className="input" value={value} onChange={(event) => change(event.target.value)}>
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
  const local = refs?.local ?? [];
  const remote = refs?.remote ?? [];
  const name = (ref: string) => ref.replace(/^refs\/(heads|remotes)\//, "");
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
    if (!canCompare) return;
    setResult(null); setError(""); setRequest({ from, to });
  };
  const loading = !!request && !result && !error;

  return <Modal title="Compare branch commits" subtitle="See which commits are present on each side." icon={<GitCompareArrows size={18} />} wide onClose={close} onSubmit={compare}
    footer={<><button type="button" className="btn" onClick={close}>Close</button><button type="submit" className="btn primary" disabled={!canCompare || loading}>Compare</button></>}>
    <div className="branch-compare-grid">
      <BranchSelect label="Branch A" value={from} exclude={to} local={local} remote={remote} change={(value) => { setFrom(value); clear(); }} />
      <BranchSelect label="Compare with" value={to} exclude={from} local={local} remote={remote} change={(value) => { setTo(value); clear(); }} />
    </div>
    {loading && <div role="status" className="hstack"><span className="loader" /> Comparing commits…</div>}
    {error && <div className="callout warn" role="alert">{error}</div>}
    {result && <div className="branch-compare-grid">
      <CommitColumn name={name(from)} oid={result.fromOid} count={result.fromCount} initial={result.fromOnly} more={(offset) => api.branchCommitPage(root, result.toOid, result.fromOid, offset)} />
      <CommitColumn name={name(to)} oid={result.toOid} count={result.toCount} initial={result.toOnly} more={(offset) => api.branchCommitPage(root, result.fromOid, result.toOid, offset)} />
    </div>}
  </Modal>;
}

function CommitColumn({ name, oid, count, initial, more }: {
  name: string; oid: string; count: number; initial: RangeCommit[]; more: (offset: number) => Promise<RangeCommit[]>;
}) {
  const [commits, setCommits] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
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
  return <section className="branch-compare-column" aria-label={`Only in ${name}`}>
    <header className="hstack"><b title={name}>Only in {name}</b><span className="pill accent">{count}</span><code title={oid}>{shortOid(oid)}</code></header>
    <div className="branch-compare-list">
      {!commits.length && <p className="batch-note">No unique commits.</p>}
      {commits.map((commit) => <article className="branch-compare-commit" key={commit.oid}>
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
