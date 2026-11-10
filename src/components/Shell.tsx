import {forgeAccountsDialog} from "./ForgeAccounts";
import { aboutDialog } from "./AboutDialog";
import { branchCommitCompare } from "./BranchCommitCompare";
import { SyncButton, syncRepositories } from "./SyncRepositories";
import { RepositoryLibraryButton, WorkspacePicker, repositoryLibraryDialog } from "./RepositoryLibrary";
import { PanelWindowsButton, usePanelWindowMenu, usePanelWindows } from "./PanelWindows";
import { WORKTREE } from "../lib/types";
import { repositoryFolderImportDialog } from "./RepositoryFolderImport";
import { useEffect, useMemo, useRef, useState } from "react";
import { validationDialog } from "./ConflictValidation";
import { useValidation, validationFresh, validationRunning } from "../lib/validation";
import { conflictHasUnsaved, useConflictDrafts } from "../lib/conflictStudio";
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
  FolderKanban,
  FolderOpen,
  FolderSearch,
  GitBranch,
  GitBranchPlus,
  GitMerge,
  GitPullRequestArrow,
  History,
  Info,
  KeyRound,
  Moon,
  LayoutGrid,
  PanelLeft,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  UserRound,
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
  Bot,
  Workflow,
} from "lucide-react";
import { useRepos, type RepoTab } from "../lib/store";
import { resolvedTheme, useSettings } from "../lib/settings";
import { useWorkspaceLayout } from "../lib/workspaceLayoutContext";
import { contextMenu, openOverlay, useUi, type MenuItem } from "../lib/ui";
import { namePathMenu } from "./NamePathMenu";
import * as A from "../lib/actions";
import * as XA from "../lib/extraActions";
import { bindingFor, prettyCombo, shortcutTitle } from "../lib/shortcuts";
import { jumpToCommit } from "./GraphView";
import { api } from "../lib/api";
import { useAppVersion } from "../lib/appVersion";
import { basename, plural, shortOid } from "../lib/format";
import { AheadBehind } from "./bits";
import { UpdateChip } from "./UpdateChip";
import { confirmDialog, reflogDialog, settingsDialog } from "./dialogs";
import { applyPatchFile, repoToolsDialog } from "./RepoTools";
import { OperationLogButton, operationLogDialog } from "./OperationLog";
import { recoveryDialog } from "./RecoveryCenter";
import {gitConnectionDialog} from "./GitConnections";

// ───────────── top bar ─────────────

export function TopBar() {
  const { panels } = usePanelWindows();
  const tabs = useRepos((s) => s.tabs);
  const active = useRepos((s) => s.active);
  const tab = active ? tabs[active] : null;
  const theme = useSettings((s) => s.theme);
  const setS = useSettings((s) => s.set);
  const status = tab?.status;
  const stashCount = tab?.refs?.stashes.length ?? 0;
  const root = tab?.root;
  const dark = resolvedTheme(theme) === "dark";
  const overview = useUi((s) => s.repositoryOverview);
  const workspacesOpen = useSettings(s => s.workspacesOpen);
  const { layout: { branchesOpen, repositoriesOpen, focusMode }, setLayout } = useWorkspaceLayout();
  const hasCommit = !!tab?.selected && tab.selected !== WORKTREE;
  const panelWindowMenu = usePanelWindowMenu(!!tab?.info, hasCommit);
  const toggleWorkspaces = () => {
    if (panels.workspaces) { panels.workspaces.focus(); return; }
    setS({ workspacesOpen: focusMode || !workspacesOpen });
    if (focusMode) setLayout({ focusMode: false });
  };
  const toggleRepositories = () => panels.repositories ? panels.repositories.focus() : setLayout({ repositoriesOpen: focusMode || !repositoriesOpen, focusMode: false });
  const openWorktrees = (repo: string) => panels.worktrees ? panels.worktrees.focus() : openOverlay({ kind: "worktrees", root: repo });
  const showView = (view: RepoTab["view"]) => {
    if (!root) return;
    useUi.setState({ repositoryOverview: false });
    useRepos.getState().patch(root, { view });
  };
  const menu: MenuItem[] = [
    { label: "Workspaces", icon: <FolderKanban size={15}/>, checked: workspacesOpen, onClick: toggleWorkspaces },
    { label: "Toggle repositories panel", icon: <PanelLeft size={15}/>, onClick: toggleRepositories },
    { label: "All repositories", icon: <LayoutGrid size={15}/>, onClick: () => useUi.setState({ repositoryOverview: true }) },
    { label: "Repository library and workspaces", onClick: () => void repositoryLibraryDialog() },
    { label: "Open repositories…", icon: <Plus size={15}/>, onClick: () => void A.openRepoDialog() },
    { label: "Import folder…", icon: <FolderSearch size={15}/>, onClick: () => void repositoryFolderImportDialog() },
    ...(root && tab?.info ? [
      { separator: true },
      { label: "History", onClick: () => showView("history") },
      { label: "Changes", onClick: () => showView("changes") },
      { label: "Pull requests / Merge requests", onClick: () => showView("pulls") },
      { label: "Toggle branches panel", onClick: () => panels.branches ? panels.branches.focus() : setLayout({ branchesOpen: !branchesOpen || focusMode, focusMode: false }) },
      { label: "Refresh repository", icon: <RefreshCw size={15}/>, onClick: () => void useRepos.getState().refresh(root) },
      { separator: true },
      { label: "Sync…", onClick: () => void syncRepositories([root]) },
      { label: "Fetch all remotes", icon: <RefreshCw size={15}/>, onClick: () => void A.fetchAll(root) },
      { label: "Pull…", icon: <ArrowDownToLine size={15}/>, onClick: () => void A.pull(root) },
      { label: "Push…", icon: <ArrowUpFromLine size={15}/>, onClick: () => void A.push(root) },
      { label: "New branch…", icon: <GitBranchPlus size={15}/>, onClick: () => void A.createBranch(root, null, tab.info?.head.branch ?? "HEAD") },
      { label: "Stash changes…", icon: <Archive size={15}/>, disabled: !status?.files.length, onClick: () => void A.stash(root) },
      { label: "Pop latest stash", icon: <ArchiveRestore size={15}/>, disabled: !stashCount, onClick: () => void A.stashApply(root, 0, true) },
      { label: "Worktree manager", icon: <FolderGit2 size={15}/>, onClick: () => openWorktrees(root) },
      { label: "Branch manager", icon: <GitBranch size={15}/>, onClick: () => openOverlay({ kind: "branches", root }) },
      { label: "Repository tools", icon: <Wrench size={15}/>, onClick: () => void repoToolsDialog(root) },
      { label: "Undo history (reflog)", icon: <History size={15}/>, onClick: () => void reflogDialog(root, oid => A.resetTo(root, oid, "reflog entry")) },
      { label: "Undo Center", icon: <ShieldCheck size={15}/>, onClick: () => void recoveryDialog(root) },
      { label: "Branch Stacks", onClick: () => openOverlay({ kind: "stacks", root }) },
      { label: "History Explorer", onClick: () => openOverlay({ kind: "historyExplorer", root }) },
      { label: "Workflow Builder", onClick: () => openOverlay({ kind: "workflows", root }) },
      { label: "Agent Workspace", onClick: () => openOverlay({ kind: "agents", root }) },
      { label: "Open terminal here", icon: <SquareTerminal size={15}/>, onClick: () => void api.openTerminal(root) },
      { label: "Show in Explorer", icon: <FolderOpen size={15}/>, onClick: () => void api.revealPath(root) },
    ] : []),
    { separator: true },
    { label: "Panels in separate windows", children: panelWindowMenu },
    { label: "Command palette", icon: <Command size={15}/>, onClick: () => useUi.getState().setPalette(true) },
    { label: "Operation log", onClick: () => void operationLogDialog(root ?? null) },
    { label: dark ? "Light theme" : "Dark theme", icon: dark ? <Sun size={15}/> : <Moon size={15}/>, onClick: () => setS({ theme: dark ? "light" : "dark" }) },
    { label: "Accounts and API connections…", icon: <UserRound size={15}/>, onClick: () => void forgeAccountsDialog(root ?? null) },
    { label: "Settings…", icon: <Settings2 size={15}/>, onClick: () => void settingsDialog(root ?? null) },
  ];

  return (
    <div className="topbar" onContextMenu={e => { if (!(e.target as HTMLElement).closest("button, select, input, .repo-current")) contextMenu(e, menu); }}>
      <div className="topbar-navigation" role="group" aria-label="Repository navigation">
        <button type="button" className={`icon-btn ${workspacesOpen ? "active" : ""}`} title="Toggle Workspaces panel" aria-label="Toggle Workspaces panel" aria-pressed={workspacesOpen} onClick={toggleWorkspaces}><FolderKanban size={16}/></button>
        <button type="button" className={`icon-btn ${repositoriesOpen && !focusMode ? "active" : ""}`} title="Toggle repositories panel" aria-label="Toggle repositories panel" aria-expanded={repositoriesOpen && !focusMode} onClick={toggleRepositories}><PanelLeft size={16} /></button>
        <button type="button" className={`icon-btn ${overview ? "active" : ""}`} title="All repositories" aria-label="All repositories" onClick={() => useUi.setState({ repositoryOverview: true })}><LayoutGrid size={16} /></button>
        <RepositoryLibraryButton />
      </div>
      <WorkspacePicker />
      <div className="repo-current" title={root ?? ""} onContextMenu={e => { if (root && !overview) contextMenu(e, namePathMenu(tab?.info?.name ?? basename(root), root, null)); }}>
        <b>{overview ? "All repositories" : tab?.info?.name ?? (root ? basename(root) : "Repositories")}</b>
        {!overview && tab?.info && <span onContextMenu={e => { if (root && tab.info?.head.branch) contextMenu(e, namePathMenu(tab.info.head.branch, root, `refs/heads/${tab.info.head.branch}`)); }}><GitBranch size={12} />{tab.info.head.branch ?? shortOid(tab.info.head.oid ?? "")}</span>}
      </div>
      <button className="icon-btn" title={shortcutTitle("Open repository", "open")} aria-label="Open repositories" onClick={() => A.openRepoDialog()}><Plus size={16} /></button>
      {root && tab?.info && !overview && (
        <div className="toolbar">
          <SyncButton roots={[root]} />
          <button className="tb-btn" aria-label="Open worktree manager" title="Worktree manager" onClick={() => openWorktrees(root)}><FolderGit2 size={15} />Worktrees</button>
          <button className="tb-btn" aria-label="Open branch manager" title="Branch manager" onClick={() => openOverlay({ kind: "branches", root })}><GitBranch size={15} />Branches</button>
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
        <button type="button" className="btn sm" aria-label="Branch Stacks" title="Branch Stacks" onClick={()=>openOverlay({kind:"stacks",root})}><GitBranch size={15}/>Stacks</button><button type="button" className="icon-btn" title="History Explorer" aria-label="History Explorer" onClick={()=>openOverlay({kind:"historyExplorer",root})}><Search size={16}/></button><button type="button" className="btn sm" title="Workflow Builder" aria-label="Workflow Builder" disabled={!root} onClick={()=>root&&openOverlay({kind:"workflows",root})}><Workflow size={14}/><span>Workflows</span></button>
          <button type="button" className="icon-btn" title="Agent Workspace" aria-label="Agent Workspace" onClick={() => openOverlay({ kind: "agents", root })}><Bot size={16} /></button>
          <button className="icon-btn" title="Open terminal here" onClick={() => api.openTerminal(root)}>
            <SquareTerminal size={16} />
          </button>
          <button className="icon-btn" title="Show in Explorer" onClick={() => api.revealPath(root)}>
            <FolderOpen size={16} />
          </button>
        </div>
      )}
      <div className="tb-sep" />
      <PanelWindowsButton hasRepository={!!tab?.info} hasCommit={hasCommit}/>
      <button className="icon-btn" title={shortcutTitle("Command palette", "palette")} onClick={() => useUi.getState().setPalette(true)}>
        <Command size={16} />
      </button>
      <OperationLogButton root={root} />
      <button className="icon-btn" title={dark ? "Light theme" : "Dark theme"} onClick={() => setS({ theme: dark ? "light" : "dark" })}>
        {dark ? <Sun size={16} /> : <Moon size={16} />}
      </button>
      <button className="icon-btn" title="Accounts and API connections" onClick={() => forgeAccountsDialog(root ?? null)}><UserRound size={16}/></button>
      <button className="icon-btn" title="Settings" onClick={() => settingsDialog(root ?? null)}>
        <Settings2 size={16} />
      </button>
      <div className="topbar-empty" aria-hidden="true"/>
    </div>
  );
}

// ───────────── operation banner ─────────────

export function OpBanner({ tab, onResolve }: { tab: RepoTab; onResolve: (path: string) => void }) {
  const validation = useValidation((s) => s.reports[tab.root]);
  useConflictDrafts((s) => s.version);
  const st = tab.info?.state;
  if (!st || st.kind === "none") return null;
  const root = tab.root;
  const conflicts = tab.status?.files.filter((f) => f.conflict) ?? [];
  const staged = tab.status?.stagedCount ?? 0;
  const current = tab.info?.head.branch ?? st.headName ?? "HEAD";
  const ok = conflicts.length === 0;
  const finish = async (action: () => void | Promise<unknown>) => {
    const unsaved = conflictHasUnsaved(root, conflicts.map((f) => f.path));
    if (unsaved && !await confirmDialog({ title: "Unsaved conflict drafts", message: "There are unsaved editor drafts. Finishing uses the files on disk. Save those drafts first to include them.", confirm: "Use files on disk" })) return;
    if (validation && !validationFresh(validation, tab.status?.stateToken, unsaved, root)) {
      if (!await confirmDialog({ title: "Continue without a current passing check?", message: "The last validation failed, was cancelled, or belongs to an older Git-visible state. You can run it again before finishing.", confirm: "Continue anyway" })) return;
    }
    await action();
  };

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
          <button className="btn primary" disabled={!ok} onClick={() => finish(() => A.confirmMerge(root, st.kind as "merge" | "squash", st.message))} title={ok ? "" : "Resolve all conflicts first"}>
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
          <button className="btn primary" disabled={!ok} onClick={() => finish(() => A.continueOp(root, st.kind))}>
            <Check size={14} /> Continue
          </button>
        </>
      );
      break;
    case "rebase": {
      icon = <GitPullRequestArrow size={18} />;
      const step = st.step && st.total ? ` · step ${st.step} of ${st.total}` : "";
      const editing = ok && st.editingCommit;
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
            <button className="btn primary" onClick={() => finish(() => A.amendAndContinue(root))}>
              <Pencil size={14} /> Amend & continue
            </button>
          ) : (
            <button className="btn primary" disabled={!ok} onClick={() => finish(() => A.continueOp(root, "rebase"))}>
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
        <button className="btn" onClick={() => validationDialog(root)}>{validationRunning(validation) ? "Check running…" : validationFresh(validation, tab.status?.stateToken, conflictHasUnsaved(root, conflicts.map((f) => f.path)), root) ? "Checks passed" : validation ? "Check result" : "Validate"}</button>
        <fieldset disabled={(tab.pendingMutations ?? 0) > 0 || validationRunning(validation)} style={{ display: "contents", border: 0, padding: 0, margin: 0 }}>{actions}</fieldset>
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

const QUIET_OPERATIONS: ReturnType<typeof useUi.getState>["repositoryOperations"] = [];

export function StatusBar() {
  const version = useAppVersion();
  const tab = useRepos((s) => (s.active ? s.tabs[s.active] : null));
  const busy = useUi((s) => s.busy);
  const operations = useUi((s) => s.repositoryOperations.some(op => op.command !== "fetch_background") ? s.repositoryOperations : QUIET_OPERATIONS);
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
      <div className="statusbar-context">
        {tab && head && (
          <span className="item" onContextMenu={e => { if (head.branch) contextMenu(e, namePathMenu(head.branch, tab.root, `refs/heads/${head.branch}`)); }}>
            <GitBranch size={12} />
            {head.branch ?? (head.detached ? `detached at ${shortOid(head.oid)}` : "no branch")}
            {st?.upstream && <span className="faint" onContextMenu={e => contextMenu(e, namePathMenu(st.upstream!, tab.root, tab.refs?.local.find(branch => branch.name === head.branch)?.upstreamFullName ?? undefined))}>→ {st.upstream}</span>}
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
          {!b && <span className="busy-dot" aria-hidden="true" />}
          {operations.filter((o) => o.phase === "running").length} running · {operations.filter((o) => o.phase === "queued").length} queued
        </button>}
        <div className="spacer" />
        {tab?.error && (
          <span className="item" style={{ color: "var(--red)" }} title={tab.error}>
            {tab.error.slice(0, 80)}
          </span>
        )}
      </div>
      <UpdateChip />
      <span className="item">{git}</span>
      <button type="button" className="item app-version" title="About Revqora" onClick={() => void aboutDialog()}>
        {version ? `Revqora v${version}` : "Revqora"}
      </button>
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
                <div className="bd">{shortcutTitle("Pick a folder with a Git repository", "open")}</div>
              </span>
            </button>
            <button className="big-action" onClick={() => void repositoryFolderImportDialog()}>
              <span className="bi"><FolderSearch size={19} /></span>
              <span>
                <div className="bt">Import folder…</div>
                <div className="bd">Find repositories and create Workspaces</div>
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
              <div key={r} className="recent-item" onClick={() => A.openRepoPath(r)} onContextMenu={e => contextMenu(e, namePathMenu(basename(r), r, null))}>
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
      { id: "import-folder", label: "Import repositories from a folder…", group: "Repository", icon: <FolderSearch size={15} />, run: () => void repositoryFolderImportDialog() },
      { id: "clone", label: "Clone repository…", group: "Repository", icon: <Download size={15} />, run: () => A.cloneRepo() },
      { id: "init", label: "New repository…", group: "Repository", icon: <Plus size={15} />, run: () => A.initRepoDialog() },
      {id:"forge-accounts",label:"Accounts and API connections",group:"App",icon:<UserRound size={15}/>,run:()=>forgeAccountsDialog(tab?.root??null)},
      { id: "settings", label: "Settings", group: "App", icon: <Settings2 size={15} />, run: () => settingsDialog(tab?.root ?? null) },
      { id: "about", label: "About Revqora", group: "App", icon: <Info size={15} />, run: () => aboutDialog() },
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
        { id:"git-connections",label:"Git connection settings…",group:"Remote",icon:<KeyRound size={15}/>,run:()=>gitConnectionDialog(root) },
        { id: "pull", label: "Pull", group: "Remote", icon: <ArrowDownToLine size={15} />, run: () => A.pull(root) },
        { id: "push", label: "Push…", group: "Remote", icon: <ArrowUpFromLine size={15} />, run: () => A.push(root) },
        { id: "branch", label: "New branch…", group: "Branch", icon: <GitBranchPlus size={15} />, run: () => A.createBranch(root, null, tab.info?.head.branch ?? "HEAD") },
        { id: "branch-manager", label: "Branch manager…", group: "Branch", icon: <GitBranch size={15} />, run: () => openOverlay({ kind: "branches", root }) },
        { id: "stash", label: "Stash changes…", group: "Changes", icon: <Archive size={15} />, run: () => A.stash(root) },
        { id: "tools", label: "Repository tools (gc, maintenance)…", group: "Repository", icon: <Wrench size={15} />, run: () => repoToolsDialog(root) },
        { id: "deleted", label: "Recently deleted branches…", group: "Branch", icon: <Undo2 size={15} />, run: () => repoToolsDialog(root, "deleted") },
        { id: "patch", label: "Apply patch file…", group: "Repository", icon: <Plus size={15} />, run: () => applyPatchFile(root) },
        { id: "browse", label: "Browse files (HEAD)", group: "Repository", icon: <FolderOpen size={15} />, run: () => openOverlay({ kind: "tree", root, rev: "HEAD" }) },
        { id: "worktree-manager", label: "Worktree manager…", group: "Repository", icon: <FolderGit2 size={15} />, run: () => openOverlay({ kind: "worktrees", root }) },
        {id:"branch-stacks",label:"Branch Stacks…",group:"Branch",icon:<GitBranch size={16}/>,run:()=>openOverlay({kind:"stacks",root})},
        { id:"history-explorer",label:"History Explorer: search changed code…",group:"Repository",icon:<Search size={16}/>,run:()=>openOverlay({kind:"historyExplorer",root}) },
        { id: "workflow-builder", label: "Workflow Builder", group: "Repository", icon: <Workflow size={16}/>, run: () => root && openOverlay({kind:"workflows",root}) },
      { id: "agent-workspace", label: "Agent Workspace…", group: "Repository", icon: <Bot size={15} />, run: () => openOverlay({ kind: "agents", root }) },
        { id: "worktree", label: "New worktree…", group: "Repository", icon: <FolderGit2 size={15} />, run: () => XA.addWorktree(root) },
        { id: "submodule", label: "Add submodule…", group: "Repository", icon: <Plus size={15} />, run: () => XA.addSubmodule(root) },
        { id: "submodules", label: "Update submodules", group: "Repository", icon: <RefreshCw size={15} />, run: () => XA.updateSubmodules(root) },
        { id: "lfs", label: "Track files with Git LFS…", group: "Repository", icon: <Plus size={15} />, run: () => XA.lfsTrack(root) },
        {
          id: "compare",
          label: "Compare branches…",
          group: "History",
          icon: <GitMerge size={15} />,
          run: () => void branchCommitCompare(root),
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
