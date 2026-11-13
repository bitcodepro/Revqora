import {forgeAccountsDialog} from "./ForgeAccounts";
import { aboutDialog } from "./AboutDialog";
import { branchCommitCompare } from "./BranchCommitCompare";
import { SyncButton, syncRepositories } from "./SyncRepositories";
import { RepositoryLibraryButton, groupEditorDialog, repositoryLibraryDialog } from "./RepositoryLibrary";
import { fetchRepositories, pullRepositories } from "./Repositories";
import { workspaceCommitSearch } from "./WorkspaceCommitSearch";
import { repositoryKey, uniqueRoots, useLibrary } from "../lib/repositoryLibrary";
import { treeAncestors } from "../lib/libraryTree";
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
  Folder,
  FolderGit2,
  FolderOpen,
  FolderSearch,
  FolderTree,
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
import { contextMenu, endBusy, openOverlay, startBusy, toast, toggleRepositoryOverview, useUi, type MenuItem } from "../lib/ui";
import { namePathMenu } from "./NamePathMenu";
import * as A from "../lib/actions";
import * as XA from "../lib/extraActions";
import { bindingFor, prettyCombo, shortcutTitle } from "../lib/shortcuts";
import { jumpToCommit } from "./GraphView";
import { api, newOpId } from "../lib/api";
import { useAppVersion } from "../lib/appVersion";
import { basename, plural, shortOid } from "../lib/format";
import { AheadBehind } from "./bits";
import { UpdateChip } from "./UpdateChip";
import { canCheckUpdates, useUpdate } from "../lib/update";
import { confirmDialog, reflogDialog, settingsDialog } from "./dialogs";
import { applyPatchFile, repoToolsDialog } from "./RepoTools";
import { OperationLogButton, operationLogDialog } from "./OperationLog";
import { recoveryDialog } from "./RecoveryCenter";
import {gitConnectionDialog} from "./GitConnections";

async function checkUpdates() {
  const update = useUpdate.getState();
  if (!canCheckUpdates(update.phase)) return;
  const id = newOpId();
  startBusy(id, "Checking for updates");
  try {
    const info = await update.check(true);
    const error = useUpdate.getState().error;
    if (error) toast.error(error, "Could not check for updates");
    else if (info && !info.available) toast.info("Revqora is up to date", `Version ${info.current}`);
  } finally {
    endBusy(id);
  }
}

// ───────────── top bar ─────────────

export function TopBar() {
  const { panels, toggleSidebar } = usePanelWindows();
  const tabs = useRepos((s) => s.tabs);
  const active = useRepos((s) => s.active);
  const tab = active ? tabs[active] : null;
  const theme = useSettings((s) => s.theme);
  const setS = useSettings((s) => s.set);
  const status = tab?.status;
  const stashCount = tab?.refs?.stashes.length ?? 0;
  const root = tab?.root;
  const repositoryName = useLibrary(s => root ? s.repositoryNames[repositoryKey(root)] : undefined) ?? tab?.info?.name ?? (root ? basename(root) : "Repositories");
  const dark = resolvedTheme(theme) === "dark";
  const overview = useUi((s) => s.repositoryOverview);
  const explorerOpen = useSettings(s => s.explorerOpen);
  const shortcuts = useSettings(s => s.shortcuts);
  const updatePhase = useUpdate(s => s.phase);
  const { layout: { repositoriesOpen, branchesOpen, focusMode } } = useWorkspaceLayout();
  const canToggleBranches = !!tab?.info;
  const showBranches = canToggleBranches && !overview && branchesOpen && !focusMode && !panels.branches;
  const hasCommit = !!tab?.selected && tab.selected !== WORKTREE;
  const panelWindowMenu = usePanelWindowMenu(!!tab?.info, hasCommit);
  const openWorktrees = (repo: string) => panels.worktrees ? panels.worktrees.focus() : openOverlay({ kind: "worktrees", root: repo });
  const showView = (view: RepoTab["view"]) => {
    if (!root) return;
    useUi.setState({ repositoryOverview: false });
    useRepos.getState().patch(root, { view });
  };
  const menu: MenuItem[] = [
    { label: "Toggle Explorer panel", icon: <FolderTree size={15}/>, checked: explorerOpen && !focusMode, hint: prettyCombo(bindingFor("workspacesPanel", shortcuts)), onClick: () => toggleSidebar("explorer") },
    { label: "Toggle repositories panel", icon: <PanelLeft size={15}/>, hint: prettyCombo(bindingFor("repositoriesPanel", shortcuts)), onClick: () => toggleSidebar("repositories") },
    { label: "Toggle branches panel", icon: <GitBranch size={15}/>, checked: showBranches, disabled: !canToggleBranches, hint: prettyCombo(bindingFor("branchesPanel", shortcuts)), onClick: () => toggleSidebar("branches") },
    { label: overview ? "Close repository overview" : "All repositories", icon: <LayoutGrid size={15}/>, onClick: toggleRepositoryOverview },
    { label: "Repository library", onClick: () => void repositoryLibraryDialog() },
    { label: "Open repositories…", icon: <Plus size={15}/>, onClick: () => void A.openRepoDialog() },
    { label: "Import folder…", icon: <FolderSearch size={15}/>, onClick: () => void repositoryFolderImportDialog() },
    ...(root && tab?.info ? [
      { separator: true },
      { label: "History", onClick: () => showView("history") },
      { label: "Changes", onClick: () => showView("changes") },
      { label: "Pull requests / Merge requests", onClick: () => showView("pulls") },
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
    { label: "Operation log", hint: prettyCombo(bindingFor("operation-log", shortcuts)), onClick: () => void operationLogDialog(root ?? null) },
    { label: dark ? "Light theme" : "Dark theme", icon: dark ? <Sun size={15}/> : <Moon size={15}/>, onClick: () => setS({ theme: dark ? "light" : "dark" }) },
    { label: "Accounts and API connections…", icon: <UserRound size={15}/>, onClick: () => void forgeAccountsDialog(root ?? null) },
    { label: "Check Updates", icon: <Download size={15}/>, disabled: !canCheckUpdates(updatePhase), onClick: () => void checkUpdates() },
    { label: "Settings…", icon: <Settings2 size={15}/>, onClick: () => void settingsDialog(root ?? null) },
  ];

  return (
    <div className="topbar" onContextMenu={e => { if (!(e.target as HTMLElement).closest("button, select, input, .repo-current")) contextMenu(e, menu); }}>
      <div className="topbar-navigation" role="group" aria-label="Repository navigation">
        <button type="button" className={`icon-btn ${explorerOpen && !focusMode ? "active" : ""}`} title={shortcutTitle("Toggle Explorer panel", "workspacesPanel")} aria-label="Toggle Explorer panel" aria-pressed={explorerOpen && !focusMode} onClick={() => toggleSidebar("explorer")}><FolderTree size={16}/></button>
        <button type="button" className={`icon-btn ${repositoriesOpen && !focusMode ? "active" : ""}`} title={shortcutTitle("Toggle repositories panel", "repositoriesPanel")} aria-label="Toggle repositories panel" aria-expanded={repositoriesOpen && !focusMode} onClick={() => toggleSidebar("repositories")}><PanelLeft size={16} /></button>
        <button type="button" className={`icon-btn ${showBranches ? "active" : ""}`} title={shortcutTitle("Toggle branches panel", "branchesPanel")} aria-label="Toggle branches panel" aria-expanded={showBranches} disabled={!canToggleBranches} onClick={() => toggleSidebar("branches")}><GitBranch size={16} /></button>
      </div>
      <div className="repo-current" title={root ?? ""} onContextMenu={e => { if (root && !overview) contextMenu(e, namePathMenu(repositoryName, root, null)); }}>
        <b>{overview ? "All repositories" : repositoryName}</b>
        {!overview && tab?.info && <span onContextMenu={e => { if (root && tab.info?.head.branch) contextMenu(e, namePathMenu(tab.info.head.branch, root, `refs/heads/${tab.info.head.branch}`)); }}><GitBranch size={12} />{tab.info.head.branch ?? shortOid(tab.info.head.oid ?? "")}</span>}
      </div>
      <button className="icon-btn" title={shortcutTitle("Open repository", "open")} aria-label="Open repositories" onClick={() => A.openRepoDialog()}><Plus size={16} /></button>
      {root && tab?.info && !overview && (
        <div className="toolbar">
          <SyncButton roots={[root]} />
          <button className="tb-btn" aria-label="Open worktree manager" title="Worktree manager" data-shortcut="worktree-manager" onClick={() => openWorktrees(root)}><FolderGit2 size={15} />Worktrees</button>
          <button className="tb-btn" aria-label="Open branch manager" title="Branch manager" data-shortcut="branch-manager" onClick={() => openOverlay({ kind: "branches", root })}><GitBranch size={15} />Branches</button>
          <button className="tb-btn" onClick={() => A.fetchAll(root)} title="Fetch all remotes" data-shortcut="fetch">
            <RefreshCw size={15} /> Fetch
          </button>
          <button className="tb-btn" onClick={() => A.pull(root)} title="Pull" data-shortcut="pull">
            <ArrowDownToLine size={15} /> Pull
            {!!status?.behind && <span className="count">{status.behind}</span>}
          </button>
          <button className="tb-btn" onClick={() => A.push(root)} title="Push" data-shortcut="push">
            <ArrowUpFromLine size={15} /> Push
            {!!status?.ahead && <span className="count">{status.ahead}</span>}
          </button>
          <div className="tb-sep" />
          <button className="tb-btn" onClick={() => A.createBranch(root, null, tab?.info?.head.branch ?? "HEAD")} title="New branch" data-shortcut="branch">
            <GitBranchPlus size={15} /> Branch
          </button>
          <button className="tb-btn" onClick={() => A.stash(root)} title="Stash changes" data-shortcut="stash" disabled={!status?.files.length}>
            <Archive size={15} /> Stash
          </button>
          <button className="tb-btn" onClick={() => A.stashApply(root, 0, true)} title="Pop latest stash" data-shortcut="pop-stash" disabled={!stashCount}>
            <ArchiveRestore size={15} /> Pop
          </button>
          <div className="tb-sep" />
          <button className="icon-btn" title="Repository tools" data-shortcut="tools" onClick={() => repoToolsDialog(root)}>
            <Wrench size={16} />
          </button>
          <button className="icon-btn" title="Undo history (reflog)" data-shortcut="reflog" onClick={() => reflogDialog(root, (oid) => A.resetTo(root, oid, "reflog entry"))}>
            <History size={16} />
          </button>
          <button type="button" className="icon-btn" title="Undo Center" data-shortcut="recovery-center" aria-label="Undo Center" onClick={() => void recoveryDialog(root)}><ShieldCheck size={16} /></button>
        <button type="button" className="btn sm" aria-label="Branch Stacks" title="Branch Stacks" data-shortcut="branch-stacks" onClick={()=>openOverlay({kind:"stacks",root})}><GitBranch size={15}/>Stacks</button><button type="button" className="icon-btn" title="History Explorer" data-shortcut="history-explorer" aria-label="History Explorer" onClick={()=>openOverlay({kind:"historyExplorer",root})}><Search size={16}/></button><button type="button" className="btn sm" title="Workflow Builder" data-shortcut="workflow-builder" aria-label="Workflow Builder" disabled={!root} onClick={()=>root&&openOverlay({kind:"workflows",root})}><Workflow size={14}/><span>Workflows</span></button>
          <button type="button" className="icon-btn" title="Agent Workspace" data-shortcut="agent-workspace" aria-label="Agent Workspace" onClick={() => openOverlay({ kind: "agents", root })}><Bot size={16} /></button>
          <button className="icon-btn" title="Open terminal here" data-shortcut="terminal" onClick={() => api.openTerminal(root)}>
            <SquareTerminal size={16} />
          </button>
        </div>
      )}
      <div className="topbar-empty" aria-hidden="true"/>
      <div className="topbar-repository-actions" role="group" aria-label="Repository actions">
        <button type="button" className={`icon-btn ${overview ? "active" : ""}`} title="All repositories" data-shortcut="overview" aria-label="All repositories" aria-pressed={overview} onClick={toggleRepositoryOverview}><LayoutGrid size={16} /></button>
        <RepositoryLibraryButton />
        {root && tab?.info && !overview && <button type="button" className="icon-btn" title="Show in Explorer" data-shortcut="show-folder" onClick={() => api.revealPath(root)}>
          <FolderOpen size={16} />
        </button>}
      </div>
      <div className="tb-sep" />
      <PanelWindowsButton hasRepository={!!tab?.info} hasCommit={hasCommit}/>
      <button className="icon-btn" title={shortcutTitle("Command palette", "palette")} onClick={() => useUi.getState().setPalette(true)}>
        <Command size={16} />
      </button>
      <OperationLogButton root={root} />
      <button className="icon-btn" title={dark ? "Light theme" : "Dark theme"} data-shortcut="theme" onClick={() => setS({ theme: dark ? "light" : "dark" })}>
        {dark ? <Sun size={16} /> : <Moon size={16} />}
      </button>
      <button className="icon-btn" title="Accounts and API connections" data-shortcut="forge-accounts" onClick={() => forgeAccountsDialog(root ?? null)}><UserRound size={16}/></button>
      <button className="icon-btn" title="Settings" data-shortcut="settings" onClick={() => settingsDialog(root ?? null)}>
        <Settings2 size={16} />
      </button>
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
  const hasOpenRepositories = useRepos((s) => s.order.length > 0);
  const hasBookmarks = useLibrary((s) => s.knownRoots.length > 0);
  const actionsCollapsed = useSettings((s) => s.repositoryActionsCollapsed);
  const { panels, toggleSidebar } = usePanelWindows();
  const { layout: { repositoriesOpen, focusMode } } = useWorkspaceLayout();
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
        {actionsCollapsed && (hasOpenRepositories || hasBookmarks) && <button type="button" className="item statusbar-repository-actions" aria-label="Show repository actions" title="Show repository actions" onClick={() => {
          useSettings.getState().set({ repositoryActionsCollapsed: false });
          if (panels.repositories || !repositoriesOpen || focusMode) toggleSidebar("repositories");
        }}><FolderGit2 size={14} /></button>}
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
  context?: string;
  search?: string;
  icon?: React.ReactNode;
  run: () => void;
}

function score(q: string, s: string): number {
  if (!q) return 1;
  const l = s.toLowerCase();
  const i = l.indexOf(q);
  if (l === q || l.replace(/…$/, "") === q) return 200;
  if (i >= 0) return 100 - Math.min(i, 80);
  let qi = 0;
  for (let k = 0; k < l.length && qi < q.length; k++) if (l[k] === q[qi]) qi++;
  return qi === q.length ? 10 : 0;
}

function paletteActions(tab: RepoTab | null | undefined): Cmd[] {
  const list: Cmd[] = [
    { id: "open", label: "Open repository…", group: "Repository", icon: <FolderOpen size={15} />, run: () => A.openRepoDialog() },
    { id: "import-folder", label: "Import repositories from a folder…", group: "Repository", icon: <FolderSearch size={15} />, run: () => void repositoryFolderImportDialog() },
    { id: "clone", label: "Clone repository…", group: "Repository", icon: <Download size={15} />, run: () => A.cloneRepo() },
    { id: "init", label: "New repository…", group: "Repository", icon: <Plus size={15} />, run: () => A.initRepoDialog() },
    {id:"forge-accounts",label:"Accounts and API connections",group:"App",icon:<UserRound size={15}/>,run:()=>forgeAccountsDialog(tab?.root??null)},
    { id: "settings", label: "Settings", group: "App", icon: <Settings2 size={15} />, run: () => settingsDialog(tab?.root ?? null) },
    { id: "about", label: "About Revqora", group: "App", icon: <Info size={15} />, run: () => aboutDialog() },
    { id: "operation-log", label: "Operation log…", group: "App", icon: <History size={15} />, run: () => operationLogDialog(tab?.root ?? null) },
    { id: "repository-library", label: "Repository library…", group: "Repository", icon: <FolderGit2 size={15} />, run: () => repositoryLibraryDialog() },
    { id: "group-create", label: "Create group…", group: "Repository", icon: <FolderTree size={15} />, run: () => groupEditorDialog() },
    { id: "check-updates", label: "Check Updates", group: "App", icon: <Download size={15} />, run: checkUpdates },
    { id: "workspace-search", label: "Search all repositories", group: "History", icon: <FolderSearch size={15} />, run: () => workspaceCommitSearch("", "quick") },
    { id: "sync-all", label: "Sync all repositories…", group: "Remote", icon: <RefreshCw size={15} />, run: () => { const roots = useRepos.getState().order; if (roots.length) void syncRepositories(roots); } },
    { id: "fetch-all", label: "Fetch all repositories", group: "Remote", icon: <Download size={15} />, run: () => fetchRepositories() },
    { id: "pull-all", label: "Pull all repositories…", group: "Remote", icon: <ArrowDownToLine size={15} />, run: () => { const roots = useRepos.getState().order; if (roots.length) void pullRepositories(roots); } },
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
      { id: "sync", label: "Sync repository…", group: "Remote", icon: <RefreshCw size={15} />, run: () => syncRepositories([root]) },
      { id:"git-connections",label:"Git connection settings…",group:"Remote",icon:<KeyRound size={15}/>,run:()=>gitConnectionDialog(root) },
      { id: "pull", label: "Pull", group: "Remote", icon: <ArrowDownToLine size={15} />, run: () => A.pull(root) },
      { id: "push", label: "Push…", group: "Remote", icon: <ArrowUpFromLine size={15} />, run: () => A.push(root) },
      { id: "branch", label: "New branch…", group: "Branch", icon: <GitBranchPlus size={15} />, run: () => A.createBranch(root, null, tab.info?.head.branch ?? "HEAD") },
      { id: "branch-manager", label: "Branch manager…", group: "Branch", icon: <GitBranch size={15} />, run: () => openOverlay({ kind: "branches", root }) },
      { id: "stash", label: "Stash changes…", group: "Changes", icon: <Archive size={15} />, run: () => A.stash(root) },
      { id: "pop-stash", label: "Pop latest stash", group: "Changes", icon: <ArchiveRestore size={15} />, run: () => { if (tab.refs?.stashes.length) void A.stashApply(root, 0, true); } },
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
      { id: "show-folder", label: "Show in Explorer", group: "Repository", icon: <FolderOpen size={15} />, run: () => api.revealPath(root) },
    );
    if (tab.view === "changes" && !useUi.getState().repositoryOverview && !tab.pendingMutations && tab.status) {
      const sel = tab.changeSel;
      const unstaged = tab.status.files.filter(file => !file.conflict && file.worktree !== ".");
      const staged = tab.layers?.active ? tab.layers.openFiles : tab.status.files.filter(file => !file.conflict && file.index !== ".");
      if (sel?.kind === "unstaged" && unstaged.some(file => file.path === sel.path && !(file.untracked && file.path.endsWith("/")))) {
        list.push({ id: "stage-file", label: "Stage selected file", group: "Changes", icon: <Plus size={15} />, run: () => A.stagePaths(root, [sel.path]) });
      }
      if (sel?.kind === "staged" && staged.some(file => file.path === sel.path)) {
        list.push({ id: "unstage-file", label: "Unstage selected file", group: "Changes", icon: <Undo2 size={15} />, run: () => A.unstagePaths(root, [sel.path]) });
      }
      if (unstaged.length) list.push({ id: "stage-all", label: "Stage all files", group: "Changes", icon: <Plus size={15} />, run: () => A.stagePaths(root, unstaged.map(file => file.path)) });
      if (staged.length) list.push({ id: "unstage-all", label: "Unstage all files", group: "Changes", icon: <Undo2 size={15} />, run: () => A.unstagePaths(root, staged.map(file => file.path)) });
    }
  }
  return list;
}

export function paletteShortcut(id: string, tab: RepoTab | null | undefined) {
  return paletteActions(tab).find(command => command.id === id)?.run;
}

export function CommandPalette() {
  const open = useUi(s => s.paletteOpen);
  const setOpen = useUi(s => s.setPalette);
  const { toggleSidebar } = usePanelWindows();
  const active = useRepos(s => s.active);
  const order = useRepos(s => s.order);
  const tabs = useRepos(s => s.tabs);
  const groups = useLibrary(s => s.groups);
  const known = useLibrary(s => s.knownRoots);
  const names = useLibrary(s => s.repositoryNames);
  const recent = useSettings(s => s.recent);
  const [q, setQ] = useState("");
  const [highlight, setHighlight] = useState<string | null>(null);
  const [branches, setBranches] = useState<Record<string, string[]>>({});
  const [loadingBranches, setLoadingBranches] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const roots = useMemo(() => uniqueRoots([...order, ...known, ...recent]), [order, known, recent]);
  const ql = q.trim().toLowerCase();
  const shouldLoad = open && !!ql;

  useEffect(() => {
    if (!open) {
      setQ("");
      setHighlight(null);
      setBranches({});
      return;
    }
    inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!shouldLoad) { setLoadingBranches(false); return; }
    let cancelled = false;
    let next = 0;
    const candidates = roots.filter(root => !useRepos.getState().tabs[root]?.refs);
    setLoadingBranches(!!candidates.length);
    const timer = window.setTimeout(async () => {
      await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, async () => {
        while (!cancelled && next < candidates.length) {
          const root = candidates[next++];
          if (useRepos.getState().tabs[root]?.refs) continue;
          try {
            const refs = await api.repositoryBranchNames(root);
            if (!cancelled) setBranches(current => ({ ...current, [root]: refs }));
          } catch { /* A saved repository can be unavailable. Keep the other results. */ }
        }
      }));
      if (!cancelled) setLoadingBranches(false);
    }, 150);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [shouldLoad, roots]);

  const openRepository = async (path: string) => {
    const repos = useRepos.getState();
    const existing = repos.order.find(root => repositoryKey(root) === repositoryKey(path));
    if (existing && repos.tabs[existing]?.info) {
      repos.activate(existing);
      return existing;
    }
    return repos.open(existing ?? path);
  };

  const revealExplorer = (group: string | null, root?: string) => {
    const library = useLibrary.getState();
    const ancestors = new Set(group ? [...treeAncestors(library.groups, group), ...(root ? [group] : [])] : []);
    if (library.groups.some(item => item.collapsed && ancestors.has(item.id))) {
      useLibrary.setState({ groups: library.groups.map(item => item.collapsed && ancestors.has(item.id) ? { ...item, collapsed: false } : item) });
    }
    library.selectGroup(group);
    useSettings.getState().set({ explorerFavoritesOnly: false });
    useUi.setState({ explorerReveal: root ? JSON.stringify([group, repositoryKey(root)]) : group });
    toggleSidebar("explorer", true);
  };

  const revealRepository = async (path: string) => {
    try {
      const opening = openRepository(path);
      const version = useRepos.getState().selectionVersion;
      const root = await opening;
      if (!root || useRepos.getState().selectionVersion !== version) return;
      const { groups, activeGroupId } = useLibrary.getState();
      const memberships = groups.filter(group => group.roots.some(item => repositoryKey(item) === repositoryKey(root)));
      revealExplorer((memberships.find(group => group.id === activeGroupId) ?? memberships[0])?.id ?? null, root);
    } catch (error) { toast.error(error, "Could not open repository"); }
  };

  const revealBranch = async (path: string, reference: string) => {
    try {
      const opening = openRepository(path);
      const version = useRepos.getState().selectionVersion;
      const root = await opening;
      if (!root || useRepos.getState().selectionVersion !== version) return;
      const cached = useRepos.getState().tabs[root]?.refs;
      const hasBranch = (refs: NonNullable<RepoTab["refs"]>) => refs.local.some(branch => branch.fullName === reference) || refs.remote.some(branch => branch.fullName === reference);
      const refs = cached && hasBranch(cached) ? cached : await api.refs(root);
      const repos = useRepos.getState();
      if (repos.active !== root || repos.selectionVersion !== version) return;
      if (!hasBranch(refs)) {
        toast.warning("Branch is no longer available");
        return;
      }
      repos.patch(root, { refs, view: "history" });
      useUi.setState({ branchReveal: { root, reference } });
      toggleSidebar("branches", true);
    } catch (error) { toast.error(error, "Could not open branch"); }
  };

  const tab = active ? tabs[active] : null;
  const filtered: Cmd[] = [];
  if (open) {
    const list = paletteActions(tab);
    if (ql) {
      if (tab && /^(?:check\s+out|checkout|merge)\s/.test(ql)) {
        for (const [kind, refs] of [["local", tab.refs?.local], ["remote", tab.refs?.remote]] as const) {
          for (const branch of refs ?? []) {
            if (branch.isHead) continue;
            list.push({ id: "checkout:" + branch.fullName, label: "Check out " + branch.name, group: "Branch action", icon: <GitBranch size={15} />,
              run: () => void A.checkout(tab.root, branch.name, kind) });
            if (kind === "local") list.push({ id: "merge:" + branch.fullName, label: "Merge " + branch.name + " into current…", group: "Branch action",
              icon: <GitMerge size={15} />, run: () => void A.mergeInto(tab.root, branch.name) });
          }
        }
      }
      const byGroup = new Map(groups.map(group => [group.id, group]));
      for (const group of groups) {
        const parents = treeAncestors(groups, group.id).reverse().map(id => byGroup.get(id)!.name).join(" / ");
        list.push({
          id: "group:" + group.id, label: group.name, group: "Folder", context: parents,
          icon: <Folder size={15} />, run: () => revealExplorer(group.id),
        });
      }
      for (const root of roots) {
        const name = names[repositoryKey(root)] ?? tabs[root]?.info?.name ?? basename(root);
        list.push({
          id: "repository:" + root, label: name, group: "Repository", context: root,
          icon: <FolderGit2 size={15} />, run: () => void revealRepository(root),
        });
        const refs = tabs[root]?.refs;
        const references = refs ? [...refs.local, ...refs.remote].map(branch => branch.fullName) : branches[root] ?? [];
        for (const reference of references) {
          const local = reference.startsWith("refs/heads/");
          const branch = reference.slice(local ? "refs/heads/".length : "refs/remotes/".length);
          list.push({
            id: JSON.stringify([root, reference]), label: branch, group: local ? "Branch" : "Remote branch",
            context: name, search: root, icon: <GitBranch size={15} />, run: () => void revealBranch(root, reference),
          });
        }
      }
    }
    const tokens = ql.split(/\s+/);
    const matches = list.map(item => {
      const context = [item.label, item.context, item.search].filter(Boolean).join(" ").toLowerCase();
      const rank = score(ql, item.label) || (tokens.every(token => context.includes(token)) ? 12 : 0);
      return { item, rank };
    }).filter(result => result.rank > 0).sort((a, b) => b.rank - a.rank);
    filtered.push(...matches.slice(0, 60).map(({ item }) => item));
  }

  const idx = Math.max(0, filtered.findIndex(item => item.id === highlight));
  const selected = filtered[idx];
  useEffect(() => {
    if (open && highlight) listRef.current?.querySelector(".palette-item.on")?.scrollIntoView({ block: "nearest" });
  }, [open, highlight, idx]);

  if (!open) return null;
  const run = (command: Cmd | undefined) => {
    if (!command) return;
    setOpen(false);
    command.run();
  };
  return (
    <div className="modal-backdrop" style={{ background: "transparent", backdropFilter: "none" }} onMouseDown={e => e.target === e.currentTarget && setOpen(false)}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <Search size={18} className="pi" />
        <input
          ref={inputRef}
          value={q}
          role="combobox"
          aria-label="Search commands, repositories, branches and folders"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls="palette-results"
          aria-activedescendant={selected ? "palette-result-" + idx : undefined}
          placeholder="Search commands, repositories, branches, folders…"
          onChange={e => { setQ(e.target.value); setHighlight(null); }}
          onKeyDown={e => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === "Escape") setOpen(false);
            else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const next = Math.max(0, Math.min(filtered.length - 1, idx + (e.key === "ArrowDown" ? 1 : -1)));
              setHighlight(filtered[next]?.id ?? null);
            } else if (e.key === "Enter") { e.preventDefault(); run(selected); }
          }}
        />
        <div className="palette-list" ref={listRef} id="palette-results" role="listbox" aria-label="Search results" aria-busy={loadingBranches}>
          {filtered.map((command, i) => (
            <div key={command.id} id={"palette-result-" + i} role="option" aria-selected={i === idx}
              className={i === idx ? "palette-item on" : "palette-item"}
              onMouseEnter={() => setHighlight(command.id)} onClick={() => run(command)}>
              {command.icon}
              <div className="palette-result-label">
                <span className="ellipsis">{command.label}</span>
                {command.context && <small className="ellipsis" title={command.context}>{command.context}</small>}
              </div>
              {bindingFor(command.id) && <span className="kbd">{prettyCombo(bindingFor(command.id))}</span>}
              <span className="group">{command.group}</span>
            </div>
          ))}
        </div>
        {(loadingBranches || !filtered.length) && <div className="palette-status faint" role="status">{loadingBranches ? "Searching branches…" : "Nothing found"}</div>}
      </div>
    </div>
  );
}
