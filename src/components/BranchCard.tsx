import { useEffect, useState } from "react";
import { GitBranch, GitCommitHorizontal, GitFork, GitMerge, Info } from "lucide-react";
import { Modal } from "./Modal";
import { showDialog, toast } from "../lib/ui";
import { api } from "../lib/api";
import { getTab } from "../lib/store";
import type { BranchDetails } from "../lib/types";
import { absoluteTime, plural, relativeTime, shortOid } from "../lib/format";
import { jumpToCommit } from "./GraphView";
import * as A from "../lib/actions";

/** Picks the branch to compare against: the current branch, else main/master/develop. */
function defaultBase(root: string, name: string): string {
  const tab = getTab(root);
  const current = tab?.info?.head.branch;
  if (current && current !== name) return current;
  const local = tab?.refs?.local.map((b) => b.name) ?? [];
  for (const c of ["main", "master", "develop", "trunk"]) if (c !== name && local.includes(c)) return c;
  const up = tab?.refs?.local.find((b) => b.name === name)?.upstream;
  return up ?? "HEAD";
}

export function branchCard(root: string, name: string) {
  return showDialog<void>((close) => <BranchCardBody root={root} name={name} close={close} />);
}

function BranchCardBody({ root, name, close }: { root: string; name: string; close: () => void }) {
  const tab = getTab(root);
  const candidates = Array.from(new Set([defaultBase(root, name), ...(tab?.refs?.local.map((b) => b.name) ?? []), ...(tab?.refs?.remote.map((b) => b.name) ?? [])])).filter((b) => b !== name);
  const [base, setBase] = useState(candidates[0] ?? "HEAD");
  const [d, setD] = useState<BranchDetails | null>(null);
  useEffect(() => {
    setD(null);
    api.branchDetails(root, name, base).then(setD, (e) => toast.error(e));
  }, [root, name, base]);
  const go = (oid: string) => {
    close();
    jumpToCommit(root, oid);
  };
  return (
    <Modal
      title={name}
      subtitle="Where this branch started, how far it went, and whether it is merged"
      icon={<GitBranch size={18} />}
      onClose={() => close()}
      footer={
        <>
          {d && !d.merged && tab?.info?.head.branch && tab.info.head.branch !== name && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                close();
                A.mergeInto(root, name);
              }}
            >
              <GitMerge size={14} /> Merge into {tab.info.head.branch}
            </button>
          )}
          <button type="button" className="btn primary" onClick={() => close()}>
            Close
          </button>
        </>
      }
    >
      <div className="field">
        <label>Compared with</label>
        <select className="select" value={base} onChange={(e) => setBase(e.target.value)}>
          {candidates.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </div>
      {!d && <div className="loading-center" style={{ minHeight: 120 }}>Loading…</div>}
      {d && (
        <>
          <div className="hstack" style={{ gap: 8, flexWrap: "wrap" }}>
            {d.merged ? <span className="pill green">merged into {d.base}</span> : <span className="pill amber">not merged into {d.base}</span>}
            <span className="pill accent">{plural(d.ahead, "commit")} ahead</span>
            {d.behind > 0 && <span className="pill blue">{d.behind} behind</span>}
            {d.authors.length > 0 && <span className="pill">{d.authors.slice(0, 3).join(", ") + (d.authors.length > 3 ? ` +${d.authors.length - 3}` : "")}</span>}
          </div>
          <div className="vstack" style={{ gap: 0, position: "relative", paddingLeft: 26 }}>
            <div style={{ position: "absolute", left: 9, top: 14, bottom: 14, width: 2, background: "linear-gradient(var(--text-faint), var(--accent))", borderRadius: 2 }} />
            <TimelineItem
              icon={<GitFork size={13} />}
              title="Started from"
              oid={d.forkPoint}
              subject={d.forkSubject ?? "No common history with the base"}
              time={d.forkTime}
              onGo={go}
            />
            {d.firstSubject && <TimelineItem icon={<GitCommitHorizontal size={13} />} title="First commit on the branch" subject={d.firstSubject} time={d.firstTime} />}
            <TimelineItem icon={<GitBranch size={13} />} title="Latest commit (tip)" oid={d.tip} subject={d.lastSubject} time={d.lastTime} onGo={go} accent />
          </div>
          {d.merged && (
            <div className="callout">
              <Info size={15} />
              <div>
                {d.base.endsWith(`/${name}`)
                  ? `Every commit of ${name} is already pushed to ${d.base}.`
                  : `Every commit of ${name} is already contained in ${d.base}. It is safe to delete this branch.`}
              </div>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

function TimelineItem({
  icon,
  title,
  oid,
  subject,
  time,
  onGo,
  accent,
}: {
  icon: React.ReactNode;
  title: string;
  oid?: string | null;
  subject: string;
  time: number | null;
  onGo?: (oid: string) => void;
  accent?: boolean;
}) {
  return (
    <div style={{ display: "flex", gap: 10, padding: "8px 0", position: "relative" }}>
      <span
        style={{
          position: "absolute",
          left: -26,
          top: 8,
          width: 20,
          height: 20,
          borderRadius: 6,
          display: "grid",
          placeItems: "center",
          background: accent ? "var(--accent)" : "var(--bg-elev3)",
          color: accent ? "#fff" : "var(--text-dim)",
          border: "1px solid var(--border-strong)",
        }}
      >
        {icon}
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div className="faint" style={{ fontSize: "var(--fs-xs)", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5 }}>
          {title}
        </div>
        <div className="ellipsis" style={{ fontWeight: 500 }}>
          {subject}
        </div>
        <div className="faint" style={{ fontSize: "var(--fs-sm)" }}>
          {time ? `${absoluteTime(time)} · ${relativeTime(time)}` : ""}
        </div>
      </div>
      {oid && onGo && (
        <button type="button" className="hash-chip" style={{ alignSelf: "center" }} onClick={() => onGo(oid)} title="Show in graph">
          {shortOid(oid)} <GitCommitHorizontal size={11} />
        </button>
      )}
    </div>
  );
}
