import { useEffect, useState } from "react";
import { CheckCircle2, CircleDashed, ExternalLink, GitPullRequest, GitPullRequestCreate, Loader2, RefreshCw, XCircle, MinusCircle, GitCompareArrows, Download } from "lucide-react";
import { api, errorMessage, isGitError } from "../lib/api";
import { getTab, useRepos, type RepoTab } from "../lib/store";
import { openOverlay, showDialog, toast } from "../lib/ui";
import * as A from "../lib/actions";
import type { Check, ForgeInfo, PullRequest } from "../lib/types";
import { relativeTime } from "../lib/format";
import { Modal } from "./Modal";

export function CheckIcon({ state, size = 14 }: { state: Check["state"]; size?: number }) {
  switch (state) {
    case "success":
      return <CheckCircle2 size={size} style={{ color: "var(--green)" }} />;
    case "failure":
      return <XCircle size={size} style={{ color: "var(--red)" }} />;
    case "pending":
      return <CircleDashed size={size} className="spin" style={{ color: "var(--amber)", animationDuration: "2.4s" }} />;
    default:
      return <MinusCircle size={size} style={{ color: "var(--text-faint)" }} />;
  }
}

export function ChecksList({ checks }: { checks: Check[] }) {
  if (!checks.length) return <div className="faint">No CI checks reported for this commit.</div>;
  return (
    <div className="vstack" style={{ gap: 4 }}>
      {checks.map((c, i) => (
        <div key={i} className="hstack" style={{ gap: 8 }}>
          <CheckIcon state={c.state} />
          <span className="ellipsis" style={{ flex: 1 }}>
            {c.name}
          </span>
          {c.url && (
            <button className="icon-btn sm" title="Open" onClick={() => api.openPath(c.url!)}>
              <ExternalLink size={12} />
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

export function summarizeChecks(checks: Check[]): Check["state"] | null {
  if (!checks.length) return null;
  if (checks.some((c) => c.state === "failure")) return "failure";
  if (checks.some((c) => c.state === "pending")) return "pending";
  return "success";
}

export function PullRequestsView({ tab }: { tab: RepoTab }) {
  const root = tab.root;
  const [forge, setForge] = useState<ForgeInfo | null>(null);
  const [items, setItems] = useState<PullRequest[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<PullRequest | null>(null);
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await api.pullRequests(root);
      setForge(r.forge);
      setItems(r.items);
      setSel((s) => (s ? r.items.find((x) => x.number === s.number) ?? null : r.items[0] ?? null));
    } catch (e) {
      setErr(errorMessage(e));
      if (!isGitError(e) || e.kind !== "auth") setItems([]);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  useEffect(() => {
    if (!sel?.headSha) return setChecks(null);
    let alive = true;
    setChecks(null);
    api.commitChecks(root, sel.headSha).then((c) => alive && setChecks(c), () => alive && setChecks([]));
    return () => {
      alive = false;
    };
  }, [root, sel?.headSha]);

  return (
    <div style={{ flex: 1, display: "grid", gridTemplateColumns: "minmax(320px, 44%) minmax(0,1fr)", minHeight: 0 }}>
      <div className="changes-left">
        <div className="hstack" style={{ padding: "10px 12px", gap: 8, borderBottom: "1px solid var(--border-soft)" }}>
          <GitPullRequest size={16} style={{ color: "var(--accent)" }} />
          <b className="ellipsis">{forge ? `${forge.project}` : "Pull requests"}</b>
          {forge && <span className="pill">{forge.kind === "github" ? "GitHub" : "GitLab"}</span>}
          <div className="spacer" />
          <button className="icon-btn" title="Refresh" onClick={load}>
            {loading ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
          </button>
          <button className="btn sm primary" onClick={() => createPullRequest(root, forge).then((pr) => pr && load())}>
            <GitPullRequestCreate size={13} /> New
          </button>
        </div>
        <div className="file-list">
          {err && (
            <div className="callout warn" style={{ margin: 8 }}>
              <div>
                {err}
                <div style={{ marginTop: 6 }}>
                  <button className="btn sm" onClick={load}>
                    Try again
                  </button>
                </div>
              </div>
            </div>
          )}
          {!items && !err && (
            <div className="loading-center" style={{ minHeight: 120 }}>
              <Loader2 className="spin" />
            </div>
          )}
          {items?.length === 0 && !err && <div className="cg-empty">No open {forge?.kind === "gitlab" ? "merge requests" : "pull requests"}.</div>}
          {items?.map((pr) => (
            <div
              key={pr.number}
              className={`file-row ${sel?.number === pr.number ? "selected" : ""}`}
              style={{ height: "auto", padding: "7px 10px", flexDirection: "column", alignItems: "stretch", gap: 2 }}
              onClick={() => setSel(pr)}
            >
              <span className="hstack" style={{ gap: 6 }}>
                <span className="mono faint">#{pr.number}</span>
                <span className="ellipsis" style={{ color: "var(--text)", fontWeight: 600 }}>
                  {pr.title}
                </span>
                {pr.draft && <span className="pill">draft</span>}
              </span>
              <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
                {pr.author} · {pr.head} → {pr.base} · {relativeTime(Date.parse(pr.created) / 1000)}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ padding: 18, overflow: "auto" }}>
        {!sel ? (
          <div className="empty">Select a pull request</div>
        ) : (
          <div className="vstack" style={{ gap: 14 }}>
            <div>
              <div className="faint mono">#{sel.number}</div>
              <h2 style={{ margin: "4px 0 6px", fontSize: "var(--fs-xl)" }}>{sel.title}</h2>
              <div className="hstack" style={{ gap: 8, flexWrap: "wrap" }}>
                <span className="ref local">
                  <span className="rn">{sel.head}</span>
                </span>
                <span className="faint">into</span>
                <span className="ref head">
                  <span className="rn">{sel.base}</span>
                </span>
                <span className="faint">
                  by {sel.author} · {relativeTime(Date.parse(sel.created) / 1000)}
                </span>
              </div>
            </div>
            <div className="hstack" style={{ flexWrap: "wrap" }}>
              <button
                className="btn"
                onClick={() =>
                  A.act(root, () => api.pullRequestCheckout(root, sel.number), { success: (b) => `Checked out ${b}`, busy: `Fetching #${sel.number}` })
                }
              >
                <Download size={14} /> Check out
              </button>
              <button
                className="btn"
                onClick={() => {
                  const remote = forge?.remote ?? "origin";
                  openOverlay({ kind: "compare", root, from: `${remote}/${sel.base}`, to: `${remote}/${sel.head}` });
                }}
              >
                <GitCompareArrows size={14} /> Compare
              </button>
              <button className="btn" onClick={() => api.openPath(sel.url)}>
                <ExternalLink size={14} /> Open in browser
              </button>
            </div>
            <div>
              <div className="section-title" style={{ marginBottom: 8 }}>
                Checks
              </div>
              {checks === null ? <Loader2 size={16} className="spin faint" /> : <ChecksList checks={checks} />}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export async function createPullRequest(root: string, forge: ForgeInfo | null): Promise<PullRequest | null> {
  const tab = getTab(root);
  const head = tab?.info?.head.branch;
  if (!head) {
    toast.warning("Check out the branch you want to open a pull request for");
    return null;
  }
  if (!tab?.status?.upstream || (tab.status.ahead ?? 0) > 0) {
    toast.info("Push the branch first", "The pull request uses the branch on the server.");
    await A.push(root);
    await useRepos.getState().refresh(root);
  }
  const remote = forge?.remote ?? "origin";
  const remoteBranches = getTab(root)?.refs?.remote.filter((b) => b.remote === remote).map((b) => b.name.slice(remote.length + 1)) ?? [];
  const base = ["main", "master", "develop"].find((b) => remoteBranches.includes(b) && b !== head) ?? remoteBranches.find((b) => b !== head) ?? "main";
  const subject = await api.lastMessage(root).catch(() => "");
  return showDialog<PullRequest | null>((close) => <CreatePrBody root={root} head={head} base={base} branches={remoteBranches} subject={subject} close={close} />);
}

function CreatePrBody({ root, head, base: initialBase, branches, subject, close }: { root: string; head: string; base: string; branches: string[]; subject: string; close: (v: PullRequest | null) => void }) {
  const [title, setTitle] = useState(subject.split("\n")[0] ?? "");
  const [body, setBody] = useState(subject.split("\n").slice(1).join("\n").trim());
  const [base, setBase] = useState(initialBase);
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      const pr = await api.pullRequestCreate(root, title.trim(), body, head, base, draft);
      toast.success(`Opened #${pr.number}`, pr.url);
      close(pr);
    } catch (e) {
      toast.error(e, "Could not open the pull request");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="New pull request"
      icon={<GitPullRequestCreate size={18} />}
      wide
      onClose={() => close(null)}
      onSubmit={submit}
      footer={
        <>
          <button type="button" className="btn" onClick={() => close(null)}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!title.trim() || busy}>
            {busy ? <Loader2 size={14} className="spin" /> : <GitPullRequestCreate size={14} />} Create
          </button>
        </>
      }
    >
      <div className="flow">
        <span className="ref local">
          <span className="rn">{head}</span>
        </span>
        <span className="faint">into</span>
        <select className="select" style={{ width: 200 }} value={base} onChange={(e) => setBase(e.target.value)}>
          {[base, ...branches.filter((b) => b !== base && b !== head)].map((b) => (
            <option key={b}>{b}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>Title</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label>Description</label>
        <textarea className="textarea" rows={7} value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
      <label className="check">
        <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} /> Open as draft
      </label>
    </Modal>
  );
}
