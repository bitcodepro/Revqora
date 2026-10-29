import { useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  CircleDot,
  Command,
  Download,
  FolderGit2,
  FolderOpen,
  GitBranch,
  GitBranchPlus,
  GitMerge,
  GitPullRequestArrow,
  History,
  Moon,
  LayoutGrid,
  PanelLeft,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  SkipForward,
  Sun,
  SquareTerminal,
  Swords,
  X,
  XCircle,
  FilePlus2,
  Pencil,
  Undo2,
  Bug,
  Wrench,
  ShieldCheck,
} from "lucide-react";
import { useRepos, type RepoTab } from "../lib/store";
import { resolvedTheme, useSettings } from "../lib/settings";
import { useWorkspaceLayout } from "../lib/workspaceLayoutContext";
import { openOverlay, useUi } from "../lib/ui";
import * as A from "../lib/actions";
import * as XA from "../lib/extraActions";
import { bindingFor, prettyCombo } from "../lib/shortcuts";
import { jumpToCommit } from "./GraphView";
import { api } from "../lib/api";
import { basename, plural, shortOid } from "../lib/format";
import { AheadBehind } from "./bits";
import { UpdateChip } from "./UpdateChip";
import { reflogDialog, settingsDialog } from "./dialogs";
import { applyPatchFile, repoToolsDialog } from "./RepoTools";
import { OperationLogButton, operationLogDialog } from "./OperationLog";
import { recoveryDialog } from "./RecoveryCenter";

// ───────────── top bar ─────────────

export function TopBar() {
  const order = useRepos((s) => s.order);
  const tabs = useRepos((s) => s.tabs);
  const active = useRepos((s) => s.active);
  const activate = useRepos((s) => s.activate);
  const tab = active ? tabs[active] : null;
  const theme = useSettings((s) => s.theme);
  const setS = useSettings((s) => s.set);
  const status = tab?.status;
  const stashCount = tab?.refs?.stashes.length ?? 0;
  const root = tab?.root;
  const dark = resolvedTheme(theme) === "dark";
  const overview = useUi((s) => s.repositoryOverview);
  const { layout: { repositoriesOpen, focusMode }, setLayout } = useWorkspaceLayout();

  return (
    <div className="topbar">
      <div className="brand" onClick={() => order.length ? useUi.setState({ repositoryOverview: true }) : activate(null)} title="Repositories overview">
        <img src="/logo.svg" alt="" />
        <span>Revqora</span>
      </div>
      <button className={`icon-btn ${repositoriesOpen && !focusMode ? "active" : ""}`} title="Toggle repositories panel" aria-label="Toggle repositories panel" aria-expanded={repositoriesOpen && !focusMode} onClick={() => setLayout({ repositoriesOpen: focusMode || !repositoriesOpen, focusMode: false })}><PanelLeft size={16} /></button>
      <button className={`icon-btn ${overview ? "active" : ""}`} title="All repositories" aria-label="All repositories" onClick={() => useUi.setState({ repositoryOverview: true })}><LayoutGrid size={16} /></button>
      <div className="repo-current" title={root ?? ""}>
        <b>{overview ? "All repositories" : tab?.info?.name ?? "Repositories"}</b>
        {!overview && tab && <span><GitBranch size={12} />{tab.info?.head.branch ?? shortOid(tab.info?.head.oid ?? "")}</span>}
      </div>
      <button className="icon-btn" title="Open repository (Ctrl+O)" aria-label="Open repositories" onClick={() => A.openRepoDialog()}><Plus size={16} /></button>
      {root && !overview && (
        <div className="toolbar">
          <button className="tb-btn" onClick={() => A.fetchAll(root)} title="Fetch all remotes">
            <RefreshCw size={15} /> Fetch
          </button>
          <button className="tb-btn" onClick={() => A.pull(root)} title="Pull">
            <ArrowDownToLine size={15} /> Pull
            {!!status?.behind && <span className="count">{status.behind}</span>}
          </button>
          <button className="tb-btn" onClick={() => A.push(root)} title="Push">
            <ArrowUpFromLine size={15} /> Push
            {!!status?.ahead && <span className="count">{status.ahead}</span>}
          </button>
          <div className="tb-sep" />
          <button className="tb-btn" onClick={() => A.createBranch(root, null, tab?.info?.head.branch ?? "HEAD")} title="New branch">
            <GitBranchPlus size={15} /> Branch
          </button>
          <button className="tb-btn" onClick={() => A.stash(root)} title="Stash changes" disabled={!status?.files.length}>
            <Archive size={15} /> Stash
          </button>
          <button className="tb-btn" onClick={() => A.stashApply(root, 0, true)} title="Pop latest stash" disabled={!stashCount}>
            <ArchiveRestore size={15} /> Pop
          </button>
          <div className="tb-sep" />
          <button className="icon-btn" title="Repository tools" onClick={() => repoToolsDialog(root)}>
            <Wrench size={16} />
          </button>
          <button className="icon-btn" title="Undo history (reflog)" onClick={() => reflogDialog(root, (oid) => A.resetTo(root, oid, "reflog entry"))}>
            <History size={16} />
          </button>
          <button type="button" className="icon-btn" title="Undo Center" aria-label="Undo Center" onClick={() => void recoveryDialog(root)}><ShieldCheck size={16} /></button>
          <button className="icon-btn" title="Open terminal here" onClick={() => api.openTerminal(root)}>
            <SquareTerminal size={16} />
          </button>
          <button className="icon-btn" title="Show in Explorer" onClick={() => api.revealPath(root)}>
            <FolderOpen size={16} />
          </button>
        </div>
      )}
      <div className="tb-sep" />
      <button className="icon-btn" title="Command palette (Ctrl+K)" onClick={() => useUi.getState().setPalette(true)}>
        <Command size={16} />
      </button>
      <OperationLogButton root={root} />
      <button className="icon-btn" title={dark ? "Light theme" : "Dark theme"} onClick={() => setS({ theme: dark ? "light" : "dark" })}>
        {dark ? <Sun size={16} /> : <Moon size={16} />}
      </button>
      <button className="icon-btn" title="Settings" onClick={() => settingsDialog(root ?? null)}>
        <Settings2 size={16} />
      </button>
    </div>
  );
}

// ───────────── operation banner ─────────────

export function OpBanner({ tab, onResolve }: { tab: RepoTab; onResolve: (path: string) => void }) {
  const st = tab.info?.state;
  if (!st || st.kind === "none") return null;
  const root = tab.root;
  const conflicts = tab.status?.files.filter((f) => f.conflict) ?? [];
  const staged = tab.status?.stagedCount ?? 0;
  const current = tab.info?.head.branch ?? st.headName ?? "HEAD";
  const ok = conflicts.length === 0;

  let icon = <GitMerge size={18} />;
  let title = "";
  let sub = "";
  let actions: React.ReactNode = null;
  const abort = (
    <button className="btn" onClick={() => A.abortOp(root, st.kind)}>
      <XCircle size={14} /> Abort
    </button>
  );
  const resolveBtn = !ok && (
    <button className="btn warn" onClick={() => onResolve(conflicts[0].path)}>
      <Swords size={14} /> Resolve {plural(conflicts.length, "conflict")}
    </button>
  );

  switch (st.kind) {
    case "merge":
    case "squash":
      title = st.kind === "merge" ? `Merging ${st.incomingLabel ?? "branch"} into ${current}` : `Squash of ${st.incomingLabel ?? "branch"} into ${current}`;
      sub = ok ? `${plural(staged, "file")} merged and staged. Review the result — nothing is committed until you confirm.` : `${plural(conflicts.length, "file")} with conflicts. Resolve them, or abort to undo everything.`;
      actions = (
        <>
          {resolveBtn}
          {abort}
          <button className="btn primary" disabled={!ok} onClick={() => A.confirmMerge(root, st.kind as "merge" | "squash", st.message)} title={ok ? "" : "Resolve all conflicts first"}>
            <Check size={14} /> Confirm merge
          </button>
        </>
      );
      break;
    case "cherry-pick":
    case "revert":
      icon = st.kind === "revert" ? <Undo2 size={18} /> : <CircleDot size={18} />;
      title = `${st.kind === "revert" ? "Reverting" : "Cherry-picking"} ${st.incomingLabel ?? ""}`;
      sub = ok ? "Conflicts resolved. Continue to create the commit." : `${plural(conflicts.length, "file")} with conflicts.`;
      actions = (
        <>
          {resolveBtn}
          {abort}
          <button className="btn" onClick={() => A.skipOp(root, st.kind)}>
            <SkipForward size={14} /> Skip
          </button>
          <button className="btn primary" disabled={!ok} onClick={() => A.continueOp(root, st.kind)}>
            <Check size={14} /> Continue
          </button>
        </>
      );
      break;
    case "rebase": {
      icon = <GitPullRequestArrow size={18} />;
      const step = st.step && st.total ? ` · step ${st.step} of ${st.total}` : "";
      const editing = ok && !!st.stoppedAt;
      title = `Rebasing ${st.headName ?? current}${step}`;
      sub = !ok
        ? `Stopped on ${st.incomingLabel ?? "a commit"} with ${plural(conflicts.length, "conflict")}.`
        : editing
          ? `Editing ${st.incomingLabel ?? "commit"}: change files and stage them, then amend & continue.`
          : "Ready to continue.";
      actions = (
        <>
          {resolveBtn}
          {abort}
          <button className="btn" onClick={() => A.skipOp(root, "rebase")}>
            <SkipForward size={14} /> Skip commit
          </button>
          {editing && staged > 0 ? (
            <button className="btn primary" onClick={() => A.amendAndContinue(root)}>
              <Pencil size={14} /> Amend & continue
            </button>
          ) : (
            <button className="btn primary" disabled={!ok} onClick={() => A.continueOp(root, "rebase")}>
              <Check size={14} /> Continue
            </button>
          )}
        </>
      );
      break;
    }
    case "bisect": {
      icon = <Bug size={18} />;
      const b = tab.extras?.bisect;
      title = b?.firstBad ? "Bisect found the first bad commit" : "Bisecting — looking for the commit that introduced a problem";
      sub = b?.firstBad
        ? `${shortOid(b.firstBad)} is the first bad commit. Finish bisect to return to your branch.`
        : b?.remaining != null
          ? `About ${b.steps ?? "?"} step(s) left (${b.remaining} revision(s)). Test the checked-out commit, then mark it.`
          : b?.message.split("\n")[0] || "Test the checked-out commit, then mark it good or bad.";
      actions = (
        <>
          {b?.firstBad ? (
            <button className="btn" onClick={() => jumpToCommit(root, b.firstBad!)}>
              <Search size={14} /> Show it
            </button>
          ) : (
            <>
              <button className="btn" onClick={() => XA.bisectMark(root, "good")}>
                <Check size={14} /> Good
              </button>
              <button className="btn" onClick={() => XA.bisectMark(root, "bad")}>
                <Bug size={14} /> Bad
              </button>
              <button className="btn" onClick={() => XA.bisectMark(root, "skip")}>
                <SkipForward size={14} /> Skip
              </button>
            </>
          )}
          <button className="btn primary" onClick={() => XA.bisectReset(root)}>
            Finish bisect
          </button>
        </>
      );
      break;
    }
    case "am":
      title = "Applying patches";
      sub = "A mailbox apply is in progress.";
      actions = abort;
      break;
  }

  return (
    <div className={`op-banner ${ok && st.kind !== "bisect" ? "ok" : ""}`}>
      <div className="op-icon">{icon}</div>
      <div className="op-copy">
        <div className="op-title ellipsis">{title}</div>
        <div className="op-sub">{sub}</div>
      </div>
      <div className="hstack op-actions">
        <fieldset disabled={(tab.pendingMutations ?? 0) > 0} style={{ display: "contents", border: 0, padding: 0, margin: 0 }}>{actions}</fieldset>
      </div>
    </div>
  );
}

// ───────────── status bar ─────────────

/** Current operation: its name, the git phase ("Receiving objects") and a smooth bar for its percent. */
function BusyItem({ label, line }: { label: string; line: string }) {
  const m = line.match(/^\s*(?:remote:\s*)?([A-Za-z][A-Za-z ]+?):\s+(\d{1,3})%/);
  const phase = m?.[1];
  const pct = m ? Math.min(100, Number(m[2])) : null;
  return (
    <span className="item busy-item" title={line || label}>
      <span className="busy-dot" />
      <b>{label}</b>
      {pct !== null ? (
        <>
          <span className="faint">{phase}</span>
          <span className="busy-meter">
            <span style={{ width: `${pct}%` }} />
          </span>
          <span className="faint busy-pct">{pct}%</span>
        </>
      ) : (
        line && <span className="busy-line faint">{line}</span>
      )}
    </span>
  );
}

export function StatusBar() {
  const tab = useRepos((s) => (s.active ? s.tabs[s.active] : null));
  const busy = useUi((s) => s.busy);
  const operations = useUi((s) => s.repositoryOperations);
  const [git, setGit] = useState("");
  useEffect(() => {
    api.gitSelection().then(
      (s) => setGit(!s || s.source === "none" ? "git not found" : `git ${s.version}`),
      () => setGit("git not found"),
    );
  }, []);
  const b = busy[busy.length - 1];
  const head = tab?.info?.head;
  const st = tab?.status;
  return (
    <div className="statusbar">
      {tab && head && (
        <span className="item">
          <GitBranch size={12} />
          {head.branch ?? (head.detached ? `detached at ${shortOid(head.oid)}` : "no branch")}
          {st?.upstream && <span className="faint">→ {st.upstream}</span>}
          {st && <AheadBehind ahead={st.ahead} behind={st.behind} />}
        </span>
      )}
      {tab?.status && (
        <span className="item">
          {tab.status.files.length === 0 ? (
            <>
              <Check size={12} style={{ color: "var(--green)" }} /> clean
            </>
          ) : (
            <>
              <FilePlus2 size={12} /> {tab.status.stagedCount} staged · {tab.status.unstagedCount} changed
              {tab.status.conflictCount ? <span style={{ color: "var(--red)" }}> · {tab.status.conflictCount} conflicts</span> : null}
            </>
          )}
        </span>
      )}
      {tab?.layers?.active && (
        <span className="item" style={{ color: "var(--accent)" }}>
          {plural(tab.layers.layers.length, "stage layer")}
        </span>
      )}
      {b && <BusyItem label={b.label} line={b.line} />}
      {!b && operations.length === 0 && (tab?.pendingMutations ?? 0) > 0 && <BusyItem label="Updating changes" line="" />}
      {operations.length > 0 && <button type="button" className="item repository-queue" aria-live="polite" title={operations.map((o) => `${o.repo}: ${o.command.replaceAll("_", " ")} (${o.phase})`).join("\n")} onClick={() => void operationLogDialog(tab?.root ?? null)}>
        {operations.filter((o) => o.phase === "running").length} running · {operations.filter((o) => o.phase === "queued").length} queued
      </button>}
      <div className="spacer" />
      {tab?.error && (
        <span className="item" style={{ color: "var(--red)" }} title={tab.error}>
          {tab.error.slice(0, 80)}
        </span>
      )}
      <UpdateChip />
      <span className="item">{git}</span>
    </div>
  );
}

// ───────────── welcome ─────────────

export function Welcome() {
  const recent = useSettings((s) => s.recent);
  const removeRecent = useSettings((s) => s.removeRecent);
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div>
          <img src="/logo.svg" alt="" width={64} height={64} style={{ filter: "drop-shadow(0 10px 30px rgba(124,92,255,.45))" }} />
          <h1>Revqora</h1>
          <p className="tag">A fast, calm Git client. Branches, history, merges and stage layers — without the terminal.</p>
          <div className="actions">
            <button className="big-action" onClick={() => A.openRepoDialog()}>
              <span className="bi">
                <FolderOpen size={19} />
              </span>
              <span>
                <div className="bt">Open repository</div>
                <div className="bd">Pick a folder with a Git repository · Ctrl+O</div>
              </span>
            </button>
            <button className="big-action" onClick={() => A.cloneRepo()}>
              <span className="bi">
                <Download size={19} />
              </span>
              <span>
                <div className="bt">Clone</div>
                <div className="bd">Copy a remote repository to this computer</div>
              </span>
            </button>
            <button className="big-action" onClick={() => A.initRepoDialog()}>
              <span className="bi">
                <Plus size={19} />
              </span>
              <span>
                <div className="bt">New repository</div>
                <div className="bd">Initialize Git in a folder</div>
              </span>
            </button>
          </div>
        </div>
        <div className="recent-card">
          <h4>Recent</h4>
          <div className="recent-list">
            {recent.length === 0 && <div className="faint" style={{ padding: 10 }}>Repositories you open will appear here. You can also drop a folder onto the window.</div>}
            {recent.map((r) => (
              <div key={r} className="recent-item" onClick={() => A.openRepoPath(r)}>
                <FolderGit2 size={18} style={{ color: "var(--accent)", flex: "none" }} />
                <div style={{ minWidth: 0 }}>
                  <div className="rn">{basename(r)}</div>
                  <div className="rp">{r}</div>
                </div>
                <button
                  className="icon-btn sm x"
                  title="Remove from list"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeRecent(r);
                  }}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ───────────── command palette ─────────────

interface Cmd {
  id: string;
  label: string;
  group: string;
  icon?: React.ReactNode;
  run: () => void;
}

function score(q: string, s: string): number {
  if (!q) return 1;
  const l = s.toLowerCase();
  const i = l.indexOf(q);
  if (i >= 0) return 100 - i;
  let qi = 0;
  for (let k = 0; k < l.length && qi < q.length; k++) if (l[k] === q[qi]) qi++;
  return qi === q.length ? 10 : 0;
}

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPalette);
  const tab = useRepos((s) => (s.active ? s.tabs[s.active] : null));
  const recent = useSettings((s) => s.recent);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ("");
      setIdx(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  const cmds = useMemo<Cmd[]>(() => {
    const list: Cmd[] = [
      { id: "open", label: "Open repository…", group: "Repository", icon: <FolderOpen size={15} />, run: () => A.openRepoDialog() },
      { id: "clone", label: "Clone repository…", group: "Repository", icon: <Download size={15} />, run: () => A.cloneRepo() },
      { id: "init", label: "New repository…", group: "Repository", icon: <Plus size={15} />, run: () => A.initRepoDialog() },
      { id: "settings", label: "Settings", group: "App", icon: <Settings2 size={15} />, run: () => settingsDialog(tab?.root ?? null) },
      { id: "operation-log", label: "Operation log…", group: "App", icon: <History size={15} />, run: () => operationLogDialog(tab?.root ?? null) },
      ...(tab ? [{ id: "recovery-center", label: "Undo Center…", group: "Repository", icon: <ShieldCheck size={15} />, run: () => recoveryDialog(tab.root) }] : []),
      {
        id: "theme",
        label: "Toggle dark / light theme",
        group: "App",
        icon: <Moon size={15} />,
        run: () => {
          const s = useSettings.getState();
          s.set({ theme: resolvedTheme(s.theme) === "dark" ? "light" : "dark" });
        },
      },
    ];
    if (tab) {
      const root = tab.root;
      list.push(
        { id: "fetch", label: "Fetch", group: "Remote", icon: <RefreshCw size={15} />, run: () => A.fetchAll(root) },
        { id: "pull", label: "Pull", group: "Remote", icon: <ArrowDownToLine size={15} />, run: () => A.pull(root) },
        { id: "push", label: "Push…", group: "Remote", icon: <ArrowUpFromLine size={15} />, run: () => A.push(root) },
        { id: "branch", label: "New branch…", group: "Branch", icon: <GitBranchPlus size={15} />, run: () => A.createBranch(root, null, tab.info?.head.branch ?? "HEAD") },
        { id: "stash", label: "Stash changes…", group: "Changes", icon: <Archive size={15} />, run: () => A.stash(root) },
        { id: "tools", label: "Repository tools (gc, maintenance)…", group: "Repository", icon: <Wrench size={15} />, run: () => repoToolsDialog(root) },
        { id: "deleted", label: "Recently deleted branches…", group: "Branch", icon: <Undo2 size={15} />, run: () => repoToolsDialog(root, "deleted") },
        { id: "patch", label: "Apply patch file…", group: "Repository", icon: <Plus size={15} />, run: () => applyPatchFile(root) },
        { id: "browse", label: "Browse files (HEAD)", group: "Repository", icon: <FolderOpen size={15} />, run: () => openOverlay({ kind: "tree", root, rev: "HEAD" }) },
        { id: "worktree", label: "New worktree…", group: "Repository", icon: <FolderGit2 size={15} />, run: () => XA.addWorktree(root) },
        { id: "submodule", label: "Add submodule…", group: "Repository", icon: <Plus size={15} />, run: () => XA.addSubmodule(root) },
        { id: "submodules", label: "Update submodules", group: "Repository", icon: <RefreshCw size={15} />, run: () => XA.updateSubmodules(root) },
        { id: "lfs", label: "Track files with Git LFS…", group: "Repository", icon: <Plus size={15} />, run: () => XA.lfsTrack(root) },
        {
          id: "compare",
          label: "Compare branches…",
          group: "History",
          icon: <GitMerge size={15} />,
          run: () => {
            const cur = tab.info?.head.branch ?? "HEAD";
            const other = tab.refs?.local.find((b) => b.name !== cur)?.name ?? "HEAD";
            openOverlay({ kind: "compare", root, from: cur, to: other });
          },
        },
        { id: "history", label: "Show history", group: "View", icon: <History size={15} />, run: () => useRepos.getState().patch(root, { view: "history" }) },
        { id: "changes", label: "Show changes", group: "View", icon: <FilePlus2 size={15} />, run: () => useRepos.getState().patch(root, { view: "changes" }) },
        { id: "reflog", label: "Undo history (reflog)…", group: "History", icon: <History size={15} />, run: () => reflogDialog(root, (oid) => A.resetTo(root, oid, "reflog entry")) },
        { id: "undo", label: "Undo last commit (keep changes)", group: "History", icon: <Undo2 size={15} />, run: () => A.undoLastCommit(root) },
        { id: "terminal", label: "Open terminal here", group: "Repository", icon: <SquareTerminal size={15} />, run: () => api.openTerminal(root) },
      );
      for (const b of tab.refs?.local ?? []) {
        if (b.isHead) continue;
        list.push({ id: "co:" + b.name, label: `Check out ${b.name}`, group: "Branch", icon: <GitBranch size={15} />, run: () => A.checkout(root, b.name, "local") });
        list.push({ id: "mg:" + b.name, label: `Merge ${b.name} into current…`, group: "Merge", icon: <GitMerge size={15} />, run: () => A.mergeInto(root, b.name) });
      }
      for (const b of tab.refs?.remote ?? []) list.push({ id: "cor:" + b.name, label: `Check out ${b.name}`, group: "Remote branch", icon: <GitBranch size={15} />, run: () => A.checkout(root, b.name, "remote") });
    }
    for (const r of recent) list.push({ id: "recent:" + r, label: `Open ${basename(r)}`, group: r, icon: <FolderGit2 size={15} />, run: () => A.openRepoPath(r) });
    return list;
  }, [tab, recent]);

  const ql = q.trim().toLowerCase();
  const filtered = cmds
    .map((c) => ({ c, s: score(ql, c.label) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 60)
    .map((x) => x.c);

  if (!open) return null;
  const run = (c: Cmd | undefined) => {
    if (!c) return;
    setOpen(false);
    c.run();
  };
  return (
    <div className="modal-backdrop" style={{ background: "transparent", backdropFilter: "none" }} onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="palette">
        <Search size={18} className="pi" />
        <input
          ref={inputRef}
          value={q}
          placeholder="Type a command, branch or repository…"
          onChange={(e) => {
            setQ(e.target.value);
            setIdx(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setIdx((i) => Math.min(filtered.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIdx((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") run(filtered[idx]);
          }}
        />
        <div className="palette-list">
          {filtered.length === 0 && <div className="faint" style={{ padding: 14 }}>Nothing found</div>}
          {filtered.map((c, i) => (
            <div key={c.id} className={`palette-item ${i === idx ? "on" : ""}`} onMouseEnter={() => setIdx(i)} onClick={() => run(c)}>
              {c.icon}
              <span className="ellipsis">{c.label}</span>
              {bindingFor(c.id) && <span className="kbd">{prettyCombo(bindingFor(c.id))}</span>}
              <span className="group ellipsis" style={{ maxWidth: 220 }}>
                {c.group}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
