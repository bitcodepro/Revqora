import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, GitCompareArrows, Loader2, X } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { getTab, useRepos } from "../lib/store";
import { closeOverlay } from "../lib/ui";
import type { Comparison, FileDiff } from "../lib/types";
import { WORKTREE } from "../lib/types";
import { plural, relativeTime, shortOid } from "../lib/format";
import { PathLabel, StatusIcon } from "./bits";
import { DiffView, useDiffOpts } from "./DiffView";
import { jumpToCommit } from "./GraphView";

export function CompareView({ root, from: initialFrom, to: initialTo, direct = false }: { root: string; from: string; to: string; direct?: boolean }) {
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [threeDot, setThreeDot] = useState(!direct);
  const [cmp, setCmp] = useState<Comparison | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<"files" | "commits">("files");
  const [file, setFile] = useState<string | null>(null);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [diffErr, setDiffErr] = useState<string | null>(null);
  const diffOpts = useDiffOpts();
  const request = useRef(0);
  const refs = getTab(root)?.refs;
  const names = useMemo(() => [...(refs?.local.map((b) => b.name) ?? []), ...(refs?.remote.map((b) => b.name) ?? []), ...(refs?.tags.map((t) => t.name) ?? []), "HEAD", WORKTREE], [refs]);

  const run = async (f = from, t = to, three = threeDot) => {
    if (!f.trim() || !t.trim()) return;
    const version = ++request.current;
    setLoading(true); setCmp(null); setDiff(null); setDiffErr(null);
    setErr(null);
    try {
      const c: Comparison =
        t.trim() === WORKTREE
          ? await api.compareWorktree(root, f.trim()).then((w) => ({ from: w.from, to: WORKTREE, base: w.from, mergeBase: null, files: w.files, ahead: [], behind: 0 }))
          : await api.compare(root, f.trim(), t.trim(), three);
      if (version !== request.current) return;
      setCmp(c);
      setFile((cur) => (cur && c.files.some((x) => x.path === cur) ? cur : c.files[0]?.path ?? null));
    } catch (e) {
      if (version !== request.current) return;
      setErr(errorMessage(e));
      setCmp(null);
    } finally {
      if (version === request.current) setLoading(false);
    }
  };

  useEffect(() => {
    setFrom(initialFrom); setTo(initialTo); setThreeDot(!direct);
    void run(initialFrom, initialTo, !direct);
    return () => { request.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, initialFrom, initialTo, direct]);

  useEffect(() => {
    if (!cmp || !file) {
      setDiff(null);
      return;
    }
    let alive = true;
    setDiffErr(null);
    (cmp.to === WORKTREE ? api.worktreeFileDiff(root, cmp.base, file, diffOpts) : api.revDiff(root, cmp.base, cmp.to, file, diffOpts)).then(
      (d) => alive && setDiff(d),
      (e) => alive && setDiffErr(errorMessage(e)),
    );
    return () => {
      alive = false;
    };
  }, [root, cmp, file, diffOpts]);

  const adds = cmp?.files.reduce((a, f) => a + (f.additions ?? 0), 0) ?? 0;
  const dels = cmp?.files.reduce((a, f) => a + (f.deletions ?? 0), 0) ?? 0;
  const swap = () => {
    setFrom(to);
    setTo(from);
    run(to, from);
  };
  const goto = (oid: string) => {
    closeOverlay();
    useRepos.getState().patch(root, { view: "history" });
    setTimeout(() => jumpToCommit(root, oid), 50);
  };

  return (
    <div className="conflict-overlay">
      <div className="cf-head" style={{ gap: 8 }}>
        <GitCompareArrows size={18} style={{ color: "var(--accent)" }} />
        <datalist id="compare-refs">
          {names.map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
        <input className="input mono" style={{ width: 220 }} list="compare-refs" value={from} onChange={(e) => setFrom(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()} placeholder="base (e.g. main)" />
        <button className="icon-btn" onClick={swap} title="Swap">
          <ArrowLeftRight size={15} />
        </button>
        <input className="input mono" style={{ width: 220 }} list="compare-refs" value={to} onChange={(e) => setTo(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()} placeholder="compare (e.g. feature)" />
        <div className="seg">
          <button
            className={threeDot ? "on" : ""}
            onClick={() => {
              setThreeDot(true);
              run(from, to, true);
            }}
            title="Changes made on the compare side since the two diverged (like a pull request)"
          >
            Since branching
          </button>
          <button
            className={!threeDot ? "on" : ""}
            onClick={() => {
              setThreeDot(false);
              run(from, to, false);
            }}
            title="Direct difference between the two snapshots"
          >
            Direct diff
          </button>
        </div>
        <button className="btn sm" onClick={() => run()} disabled={loading}>
          {loading ? <Loader2 size={13} className="spin" /> : "Compare"}
        </button>
        <div className="spacer" />
        <button className="btn" onClick={closeOverlay}>
          <X size={14} /> Close
        </button>
      </div>
      {err && <div className="empty">{err}</div>}
      {cmp && (
        <div className="hstack" style={{ padding: "8px 16px", borderBottom: "1px solid var(--border)", gap: 8, flexWrap: "wrap" }}>
          <span className="pill accent">{plural(cmp.ahead.length, "commit")} only in {to}</span>
          <span className="pill blue">{plural(cmp.behind, "commit")} only in {from}</span>
          <span className="pill">{plural(cmp.files.length, "file")} changed</span>
          <span className="stats">
            <span className="a">+{adds}</span>
            <span className="d">−{dels}</span>
          </span>
          {threeDot && cmp.mergeBase && <span className="faint">since common ancestor {shortOid(cmp.mergeBase)}</span>}
        </div>
      )}
      {cmp && (
        <div style={{ flex: 1, display: "grid", gridTemplateColumns: "360px minmax(0,1fr)", minHeight: 0 }}>
          <div className="changes-left">
            <div className="seg" style={{ margin: "8px 10px" }}>
              <button className={tab === "files" ? "on" : ""} onClick={() => setTab("files")}>
                Files ({cmp.files.length})
              </button>
              <button className={tab === "commits" ? "on" : ""} onClick={() => setTab("commits")}>
                Commits ({cmp.ahead.length})
              </button>
            </div>
            <div className="file-list">
              {tab === "files" &&
                (cmp.files.length ? (
                  cmp.files.map((f) => (
                    <div key={f.path} className={`file-row ${file === f.path ? "selected" : ""}`} onClick={() => setFile(f.path)} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
                      <StatusIcon code={f.status} />
                      <PathLabel path={f.path} />
                      {!f.binary && (
                        <span className="stats">
                          {f.additions ? <span className="a">+{f.additions}</span> : null}
                          {f.deletions ? <span className="d">−{f.deletions}</span> : null}
                        </span>
                      )}
                    </div>
                  ))
                ) : (
                  <div className="cg-empty">No differences.</div>
                ))}
              {tab === "commits" &&
                (cmp.ahead.length ? (
                  cmp.ahead.map((c) => (
                    <div key={c.oid} className="file-row" style={{ height: "auto", padding: "6px 8px", flexDirection: "column", alignItems: "stretch", gap: 2 }} onClick={() => goto(c.oid)} title="Show in graph">
                      <span className="ellipsis" style={{ color: "var(--text)", fontWeight: 500 }}>
                        {c.subject}
                      </span>
                      <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
                        {shortOid(c.oid)} · {c.author} · {relativeTime(c.time)}
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="cg-empty">No commits only in {to}.</div>
                ))}
            </div>
          </div>
          <DiffView
            diff={diff}
            error={diffErr}
            loading={!!file && !diff}
            mode="readonly"
            path={file ?? ""}
            root={root}
            images={
              file
                ? { old: { rev: `${cmp.base}:${cmp.files.find((x) => x.path === file)?.oldPath ?? file}` }, new: cmp.to === WORKTREE ? { worktree: file } : { rev: `${cmp.to}:${file}` } }
                : undefined
            }
            emptyText="Select a file"
          />
        </div>
      )}
    </div>
  );
}
