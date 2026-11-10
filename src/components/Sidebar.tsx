import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Cloud,
  CloudOff,
  Copy,
  Eraser,
  Eye,
  Folder,
  FolderGit2,
  FolderOpen,
  GitBranch,
  Globe,
  HardDrive,
  Lock,
  Package,
  PanelLeftClose,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  Tag,
  Trash2,
  X as ClearIcon,
} from "lucide-react";
import * as X from "../lib/extraActions";
import { useWorkspaceLayout } from "../lib/workspaceLayoutContext";
import type { BranchInfo } from "../lib/types";
import { CURRENT_HISTORY_BRANCH, loadGraph, useRepos, type RepoTab } from "../lib/store";
import { contextMenu, copyText, openOverlay, useUi } from "../lib/ui";
import * as A from "../lib/actions";
import { api } from "../lib/api";
import { basename, joinPath, relativeTime } from "../lib/format";
import { AheadBehind } from "./bits";
import { branchMenu, tagMenu } from "./menus";
import { reviewBranchCleanup } from "./BranchCleanup";
import { usePanelTitleMenu, usePanelWindows } from "./PanelWindows";
import { namePathMenu } from "./NamePathMenu";
import { highlightBranch, jumpToCommit } from "./GraphView";
import { promptDialog } from "./dialogs";
import { branchConnection, branchPairs } from "../lib/branchPresentation";
import {sidebarBranchesKey,sidebarBranchPreferences,selectSidebarBranches} from "../lib/sidebarBranches";
import {loadBranchPreferences,preferencesKey} from "../lib/branchManager";

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  branch?: BranchInfo;
}

function buildTree(branches: BranchInfo[], strip = 0, flat=false): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  for (const b of branches) {
    if(flat){const name=b.name.split("/").slice(strip).join("/");root.children.set(b.fullName,{name,path:b.fullName,children:new Map(),branch:b});continue;}
    const parts = b.name.split("/").slice(strip);
    let node = root;
    parts.forEach((p, i) => {
      const key = i === parts.length - 1 ? `b:${p}` : `d:${p}`;
      if (!node.children.has(key)) node.children.set(key, { name: p, path: parts.slice(0, i + 1).join("/"), children: new Map() });
      node = node.children.get(key)!;
      if (i === parts.length - 1) node.branch = b;
    });
  }
  return root;
}

function sortedChildren(n: TreeNode,recent=false): TreeNode[] {
  if(recent)return [...n.children.values()].sort((a,b)=>(b.branch?.time??0)-(a.branch?.time??0)||a.name.localeCompare(b.name));
  return [...n.children.entries()]
    .sort(([ka, a], [kb, b]) => {
      const da = ka.startsWith("d:") ? 0 : 1;
      const db = kb.startsWith("d:") ? 0 : 1;
      return da - db || a.name.localeCompare(b.name);
    })
    .map(([, v]) => v);
}

export function Sidebar({ tab, onHide }: { tab: RepoTab; onHide?: () => void }) {
  const panelMenu = usePanelTitleMenu("branches");
  const { panels } = usePanelWindows();
  const { setLayout } = useWorkspaceLayout();
  const root = tab.root;
  const [branchPrefs,setBranchPrefs]=useState(()=>{try{return sidebarBranchPreferences(JSON.parse(localStorage.getItem(sidebarBranchesKey(root))??"null"));}catch{return sidebarBranchPreferences(null);}});
  const [authorQuery,setAuthorQuery]=useState(()=>loadBranchPreferences(root).authorQuery);
  useEffect(()=>{try{localStorage.setItem(sidebarBranchesKey(root),JSON.stringify(branchPrefs));}catch{}},[root,branchPrefs]);
  useEffect(()=>{const changed=(e:Event)=>{const d=(e as CustomEvent).detail;if(d?.root===root)setAuthorQuery(d.query);};window.addEventListener("revqora:branch-author",changed);return()=>window.removeEventListener("revqora:branch-author",changed);},[root]);
  const configureAuthor=async()=>{const value=await promptDialog({title:"Branch creator filter",label:"Creator email or name",initial:authorQuery,help:"Match the branch creator recorded in local creation logs. Leave empty to use Git user.email. Remote imports and missing or expired logs have unknown creators and are excluded."});if(value===null)return;const query=value.trim().slice(0,256);setAuthorQuery(query);setBranchPrefs(p=>({...p,onlyMine:!!query||!!tab.refs?.identityEmail}));try{localStorage.setItem(preferencesKey(root),JSON.stringify({...loadBranchPreferences(root),authorQuery:query}));}catch{}window.dispatchEvent(new CustomEvent("revqora:branch-author",{detail:{root,query}}));};
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ tags: true });
  const [openDirs, setOpenDirs] = useState<Record<string, boolean>>({});
  const [selection, setSelection] = useState<BranchInfo[]>([]);
  const selectionAnchor = useRef<string | null>(null);
  const checkoutFromCurrentHistory = useRef<string | null>(null);
  const cleanupPending = useRef(false);
  const refs = tab.refs;
  const extras = tab.extras;
  const f = filter.trim().toLowerCase();
  const match = (s: string) => !f || s.toLowerCase().includes(f);
  const current = tab.info?.head.branch;
  const filterGraph = (reference: string) => {
    useRepos.getState().patch(root, { view: "history", branchFilter: reference, viewedBranch: reference, selected: null, multi: [], historyJump: null });
    if(!panels.history&&useUi.getState().repositoryOverview)useUi.setState({repositoryOverview:false});
    void useRepos.getState().refresh(root, { graph: true });
  };
  const viewBranch = (branch: BranchInfo) => {
    const repos = useRepos.getState();
    const revealHistory = useUi.getState().repositoryOverview && !panels.history;
    const shown = tab.branchFilter === CURRENT_HISTORY_BRANCH ? `refs/heads/${current ?? ""}` : tab.branchFilter;
    const scope = tab.branchFilter && shown !== branch.fullName ? branch.fullName : tab.branchFilter;
    if (tab.view === "history" && !revealHistory && scope === tab.branchFilter && tab.graph) {
      repos.patch(root, { viewedBranch: branch.fullName });
      jumpToCommit(root, branch.oid);
      return;
    }
    repos.patch(root, { viewedBranch: branch.fullName, view: "history", selected: branch.oid, multi: [], branchFilter: scope, historyJump: branch.oid });
    if (revealHistory) {
      useUi.setState({ repositoryOverview: false });
      window.focus();
    }
    if (scope !== tab.branchFilter || !tab.graph) void repos.refresh(root, { graph: true });
  };

  const pairs = useMemo(() => branchPairs(refs?.local ?? [], refs?.remote ?? []), [refs]);
  const local = useMemo(() => selectSidebarBranches(refs?.local??[],branchPrefs,authorQuery,refs?.identityEmail??null,filter), [refs,branchPrefs,authorQuery,filter]);
  const remoteByName = useMemo(() => {
    const m = new Map<string, BranchInfo[]>();
    for (const r of refs?.remotes ?? []) m.set(r.name, []);
    for (const b of selectSidebarBranches(branchPairs(local,refs?.remote??[]).remoteOnly,branchPrefs,authorQuery,refs?.identityEmail??null,filter)) {
      const k = b.remote ?? "origin";
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(b);
    }
    return m;
  }, [refs,local,branchPrefs,authorQuery,filter]);
  const tags = (refs?.tags ?? []).filter((t) => match(t.name));
  const stashes = (refs?.stashes ?? []).filter((s) => match(s.message));

  const toggle = (k: string) => setCollapsed((c) => ({ ...c, [k]: !c[k] }));
  const isOpen = (k: string) => (f ? true : openDirs[k] ?? true);
  const clearSelection = () => { setSelection([]); selectionAnchor.current = null; };

  const chooseBranch = (branch: BranchInfo, toggle: boolean, range: boolean) => {
    const reference = branch.fullName;
    if (range && selectionAnchor.current) {
      const anchor = visibleRefs.indexOf(selectionAnchor.current);
      const end = visibleRefs.indexOf(reference);
      if (anchor >= 0 && end >= 0) {
        const selectedRange = visibleRefs.slice(Math.min(anchor, end), Math.max(anchor, end) + 1).map((ref) => branchesByRef.get(ref)!);
        setSelection(toggle ? [...selected, ...selectedRange.filter((row) => !selectedSet.has(row.fullName))] : selectedRange);
        return;
      }
    }
    selectionAnchor.current = reference;
    if (toggle) setSelection(selectedSet.has(reference) ? selected.filter((row) => row.fullName !== reference) : [...selected, branch]);
    else {
      setSelection([branch]);
      viewBranch(branch);
    }
  };

  const deleteSelected = async () => {
    if (cleanupPending.current || !selected.length || selected.length > 50) return;
    cleanupPending.current = true;
    try {
      if (selected.length === 1) {
        const branch = selected[0];
        if (branch.fullName.startsWith("refs/heads/")) {
          if (branch.name !== current) await A.deleteBranch(root, branch.name);
        } else {
          await A.deleteRemoteBranch(root, branch.name);
        }
        return;
      }
      const preferences = loadBranchPreferences(root);
      const bases = (refs?.local ?? []).map((branch) => ({ reference: branch.fullName, name: branch.name }));
      const preferredBase = bases.find((branch) => branch.reference === preferences.base)?.reference;
      await reviewBranchCleanup({
        root, rules: preferences.protections, bases,
        initial: selected.map(({ fullName: reference, oid }) => ({ reference, oid, mode: reference.startsWith("refs/heads/") ? "local" : "remote" })),
        initialBase: preferredBase ?? (current ? `refs/heads/${current}` : ""),
      });
    } finally {
      cleanupPending.current = false;
    }
  };

  const renderTree = (node: TreeNode, kind: "local" | "remote", depth: number, prefix: string): ReactNode[] =>
    sortedChildren(node,branchPrefs.sort==="recent").flatMap((n) => {
      const pad = 10 + depth * 14;
      if (n.branch) {
        const b = n.branch;
        const isCur = kind === "local" && b.name === current;
        const connection = branchConnection(b);
        const upstream = pairs.upstreams.get(b.fullName);
        const viewed = tab.viewedBranch ?? tab.branchFilter;
        return [
          <div
            key={b.fullName}
            data-branch-name={b.name}
            data-branch-kind={kind}
            data-branch-ref={b.fullName}
            tabIndex={selectionAnchor.current === b.fullName || (!selectionAnchor.current && isCur) ? 0 : -1}
            className={`sb-item ${isCur ? "current" : ""} ${selectedSet.has(b.fullName) ? "branch-selected" : ""} ${viewed && (viewed === b.fullName || viewed === upstream?.fullName) ? "viewed-branch" : ""}`}
            style={{ paddingLeft: pad + 16 }}
            title={`${b.name}\n${b.subject}\n${b.author} · ${relativeTime(b.time)}\n${b.creator?`Created by ${b.creator.name} <${b.creator.email}> (local creation log)`:"Branch creator unknown"}${b.upstream ? `\ntracks ${b.upstream}` : ""}\nCtrl+Shift+click to toggle selection; Shift+click to select a range${isCur ? "" : "\nCtrl+click or double-click to check out"}`}
            onMouseDown={(e) => { if (e.button === 0 && (e.ctrlKey || e.metaKey || e.shiftKey)) e.preventDefault(); }}
            onClick={(e) => {
              if (e.button !== 0) return;
              e.currentTarget.focus({ preventScroll: true });
              const modifier = e.ctrlKey || e.metaKey;
              if (modifier && !e.shiftKey) {
                checkoutFromCurrentHistory.current = null;
                if (!isCur && e.detail <= 1) void A.checkout(root, b.name, kind);
                return;
              }
              if (e.detail <= 1) checkoutFromCurrentHistory.current = tab.branchFilter === CURRENT_HISTORY_BRANCH && !e.shiftKey ? b.fullName : null;
              chooseBranch(b, modifier, e.shiftKey && !modifier);
            }}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              chooseBranch(b, e.ctrlKey || e.metaKey, e.shiftKey);
            }}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData("revqora/branch", b.name);
              e.dataTransfer.effectAllowed = "link";
            }}
            onDragOver={(e) => e.dataTransfer.types.includes("revqora/branch") && e.preventDefault()}
            onDrop={(e) => {
              const src = e.dataTransfer.getData("revqora/branch");
              if (!src || src === b.name) return;
              const items = isCur
                ? [
                    { label: `Merge ${src} into ${b.name}…`, onClick: () => A.mergeInto(root, src) },
                    { label: `Rebase ${b.name} onto ${src}`, onClick: () => A.rebaseOnto(root, src) },
                    { separator: true },
                    { label: `Compare ${src} with ${b.name}`, onClick: () => openOverlay({ kind: "compare", root, from: b.name, to: src }) },
                  ]
                : [
                    { label: `Compare ${src} with ${b.name}`, onClick: () => openOverlay({ kind: "compare", root, from: b.name, to: src }) },
                    { label: `Check out ${b.name}, then merge ${src}…`, onClick: async () => (await A.checkout(root, b.name, kind)) !== undefined && A.mergeInto(root, src) },
                  ];
              contextMenu(e, items);
            }}
            onMouseEnter={() => highlightBranch(root, b.oid)}
            onMouseLeave={() => highlightBranch(root, null)}
            onDoubleClick={(e) => {
              if (isCur || e.ctrlKey || e.metaKey || e.shiftKey) return;
              const restoreCurrentHistory = checkoutFromCurrentHistory.current === b.fullName;
              checkoutFromCurrentHistory.current = null;
              useRepos.getState().patch(root, {
                ...(restoreCurrentHistory ? { branchFilter: CURRENT_HISTORY_BRANCH } : {}),
                selected: null, multi: [], historyJump: null,
              });
              if (restoreCurrentHistory) void loadGraph(root);
              void A.checkout(root, b.name, kind);
            }}
            onContextMenu={(e) =>
              contextMenu(e, selected.length > 1 && selectedSet.has(b.fullName) ? [
                { label: `Delete ${selected.length} branches…`, icon: <Trash2 size={14} />, danger: true, disabled: selected.length > 50,
                  hint: selected.length > 50 ? "Select up to 50" : undefined, onClick: () => void deleteSelected() },
                { label: "Clear selection", onClick: clearSelection },
              ] : [
                ...branchMenu(root, b.name, kind),
                ...(upstream ? [{ label: `Upstream: ${upstream.name}`, icon: <Cloud size={14} />, children: [
                  { label: "Show tip in history", icon: <GitBranch size={14} />, onClick: () => viewBranch(upstream) },
                  { label: "Show only this branch in graph", icon: <Eye size={14} />, onClick: () => filterGraph(upstream.fullName) },
                  { separator: true },
                  ...branchMenu(root, upstream.name, "remote"),
                ] }] : []),
                { separator: true },
                {
                  label: "Show only this branch in graph",
                  icon: <Eye size={14} />,
                  onClick: () => filterGraph(b.fullName),
                },
              ])
            }
          >
            {kind === "local" ? <GitBranch size={13} style={{ flex: "none", color: isCur ? "var(--accent)" : undefined }} /> : <Cloud size={13} style={{ flex: "none" }} />}
            <span className="label">{n.name}</span>
            <span className="meta">
              {kind === "local" && <span className={`branch-connection ${connection.kind}`} role="img" aria-label={connection.title} title={connection.title}>{connection.kind === "gone" ? <CloudOff size={13} /> : connection.kind === "paired" ? <Cloud size={13} /> : <HardDrive size={13} />}</span>}
              {kind === "local" && tab.squashMerged.includes(b.name) && (
                <span className="pill amber" title={`Changes appear integrated in ${current ?? "the current branch"}. Original commit SHAs can still be outside it; review unique history before deletion.`}>
                  integrated
                </span>
              )}
              <AheadBehind ahead={b.ahead} behind={b.behind} />
            </span>
          </div>,
        ];
      }
      const key = `${kind}:${prefix}${n.path}`;
      const open = isOpen(key);
      return [
        <div key={key} className="sb-item" style={{ paddingLeft: pad }} onClick={() => setOpenDirs((o) => ({ ...o, [key]: !open }))}>
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <Folder size={13} style={{ flex: "none", color: "var(--text-faint)" }} />
          <span className="label">{n.name}</span>
        </div>,
        ...(open ? renderTree(n, kind, depth + 1, prefix) : []),
      ];
    });

  // Every section yields flat rows so the whole sidebar can be virtualized.
  const section = (id: string, title: string, count: number, icon: ReactNode, actions: ReactNode, body: ReactNode[]): ReactNode[] => [
    <div key={`sec:${id}`} title={id === "remotes" ? "Remote-only branches. Configured upstreams are shown with their local branch under Branches." : undefined} className={`sb-section-head ${collapsed[id] ? "collapsed" : ""}`} onClick={() => toggle(id)}>
      <ChevronDown size={12} className="chev" />
      {icon}
      <span>{title}</span>
      <span className="pill" style={{ height: 16, fontSize: 10 }}>
        {count}
      </span>
      <div className="actions" onClick={(e) => e.stopPropagation()}>
        {actions}
      </div>
    </div>,
    ...(collapsed[id] ? [] : body),
  ];
  const empty = (key: string, text: string) => [
    <div key={key} className="sb-empty">
      {text}
    </div>,
  ];

  const branchesByRef = useMemo(() => new Map([...local, ...[...remoteByName.values()].flat()].map((branch) => [branch.fullName, branch])), [local, remoteByName]);
  const selected = selection.filter((branch) => branchesByRef.has(branch.fullName));
  const selectedSet = new Set(selected.map((branch) => branch.fullName));
  const branchRows = [
        ...section(
          "local",
          "Branches",
          local.length,
          <GitBranch size={12} />,
          <button className="icon-btn sm" title="New branch" onClick={() => A.createBranch(root, null, current ?? "HEAD")}>
            <Plus size={13} />
          </button>,
          collapsed.local ? [] : local.length ? renderTree(buildTree(local,0,branchPrefs.sort==="recent"), "local", 0, "") : empty("empty-local", f||branchPrefs.onlyMine ? "No matches" : "No branches yet"),
        ),
        ...section(
          "remotes",
          "Remotes",
          [...remoteByName.values()].reduce((n,list)=>n+list.length,0),
          <Globe size={12} />,
          <button className="icon-btn sm" title="Add remote" onClick={() => A.addRemote(root)}>
            <Plus size={13} />
          </button>,
          collapsed.remotes ? [] : remoteByName.size === 0
            ? empty("empty-remotes", "No remotes")
            : [...remoteByName.entries()].flatMap(([name, list]) => {
              const key = `remote-root:${name}`;
              const open = isOpen(key);
              const info = refs?.remotes.find((r) => r.name === name);
              return [
                  <div
                    key={key}
                    className="sb-item"
                    style={{ paddingLeft: 10 }}
                    onClick={() => setOpenDirs((o) => ({ ...o, [key]: !open }))}
                    title={info?.fetchUrl}
                    onContextMenu={(e) =>
                      contextMenu(e, [
                        { label: `Fetch ${name}`, icon: <Play size={14} />, onClick: () => A.act(root, () => api.fetch(root, name, true, `f-${Date.now()}`), { success: `Fetched ${name}`, busy: `Fetching ${name}` }) },
                        { label: "Copy URL", icon: <Copy size={14} />, onClick: () => copyText(info?.fetchUrl ?? "", "URL copied") },
                        {
                          label: "Change URL…",
                          icon: <Pencil size={14} />,
                          onClick: async () => {
                            const url = await promptDialog({ title: `URL of ${name}`, initial: info?.fetchUrl ?? "" });
                            if (url) A.act(root, () => api.remoteSetUrl(root, name, url), { success: "URL updated" });
                          },
                        },
                        { separator: true },
                        { label: `Remove ${name}…`, icon: <Trash2 size={14} />, danger: true, onClick: () => A.act(root, () => api.remoteRemove(root, name), { success: `Removed ${name}` }) },
                      ])
                    }
                  >
                    {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                    <Server size={13} style={{ flex: "none" }} />
                    <span className="label">{name}</span>
                    <span className="meta">{list.length}</span>
                  </div>,
                  ...(open ? renderTree(buildTree(list, 1,branchPrefs.sort==="recent"), "remote", 1, name + "/") : []),
              ];
            }),
        ),
  ];
  // Use the complete visible order, including rows outside the virtual viewport.
  const visibleRefs = (branchRows as ReactElement[]).map((row) => String(row.key)).filter((ref) => branchesByRef.has(ref));

  return (
    <aside className="sidebar" onKeyDown={(e) => {
      if (e.defaultPrevented || !(e.target as Element).closest("[data-branch-ref]")) return;
      if (e.key === "Escape" && selected.length > 1) {
        e.preventDefault();
        e.stopPropagation();
        clearSelection();
      }
      if (e.key === "Delete" && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        void deleteSelected();
      }
    }}>
      <div className="branches-heading" onContextMenu={panelMenu}><GitBranch size={14} /><b>Branches</b><div className="spacer" /><button className="icon-btn sm" aria-label="Branch manager" title="Branch manager" onClick={() => openOverlay({ kind: "branches", root: tab.root })}><GitBranch size={14} /></button><button className="icon-btn sm" title="Hide branches" aria-label="Hide branches" onClick={onHide ?? (() => setLayout({ branchesOpen: false }))}><PanelLeftClose size={14} /></button></div>
      <div className="sb-repo">
        <div className="input-wrap">
          <Search size={13} />
          <input className="input sm" placeholder="Filter branches, tags, stashes" value={filter} onChange={(e) => { clearSelection(); setFilter(e.target.value); }} />
        </div>
        <div className="sb-branch-filters"><button type="button" className={`btn sm ${branchPrefs.onlyMine?"active":""}`} aria-pressed={branchPrefs.onlyMine} disabled={!branchPrefs.onlyMine&&!authorQuery&&!refs?.identityEmail} title={`Recorded branch creator ${authorQuery?`matches: ${authorQuery}`:`email equals Git user.email: ${refs?.identityEmail??"not configured"}`}`} onClick={()=>{ clearSelection(); setBranchPrefs(p=>({...p,onlyMine:!p.onlyMine})); }}>My branches</button><button type="button" className="icon-btn sm" aria-label="Sidebar branch author filter" title="Choose branch creator email or name" onClick={()=>void configureAuthor()}><Pencil size={13}/></button><select className="select" aria-label="Branch list order" value={branchPrefs.sort} onChange={e=>{ clearSelection(); setBranchPrefs(p=>({...p,sort:e.target.value as "recent"|"name"})); }}><option value="recent">Recent first</option><option value="name">Name / folders</option></select></div>
        {selected.length > 1 && <div className="sb-branch-selection hstack">
          <span className="muted" role="status">{selected.length} selected</span>
          <button type="button" className="btn sm danger" disabled={selected.length > 50} title={selected.length > 50 ? "Select up to 50 branches per cleanup" : undefined} onClick={() => void deleteSelected()}><Trash2 size={13} /> Delete…</button>
          <button type="button" className="icon-btn sm" title="Clear branch selection" aria-label="Clear branch selection" onClick={clearSelection}><ClearIcon size={14} /></button>
        </div>}
      </div>
      <VirtualRows
        rows={[
        ...branchRows,
        ...section(
          "tags",
          "Tags",
          refs?.tags.length ?? 0,
          <Tag size={12} />,
          null,
          tags.length
            ? tags.map((t) => (
              <div
                key={t.name}
                className="sb-item"
                style={{ paddingLeft: 26 }}
                title={t.subject}
                onClick={() => jumpToCommit(root, t.target)}
                onContextMenu={(e) => contextMenu(e, tagMenu(root, t.name, t.target))}
              >
                <Tag size={13} style={{ flex: "none", color: "var(--amber)" }} />
                <span className="label">{t.name}</span>
                <span className="meta">{relativeTime(t.time)}</span>
              </div>
            ))
            : empty("empty-tags", "No tags"),
        ),
        ...section(
          "stashes",
          "Stashes",
          refs?.stashes.length ?? 0,
          <Archive size={12} />,
          <button className="icon-btn sm" title="Stash changes" onClick={() => A.stash(root)}>
            <Plus size={13} />
          </button>,
          stashes.length
            ? stashes.map((s) => (
              <div
                key={s.oid}
                className="sb-item"
                style={{ paddingLeft: 26 }}
                title={`${s.name}: ${s.message}`}
                onClick={() => openOverlay({ kind: "stash", root, index: s.index, oid: s.oid })}
                onDoubleClick={() => A.stashApply(root, s.index, false, s.oid)}
                onContextMenu={(e) =>
                  contextMenu(e, [
                    { label: "Show contents", onClick: () => openOverlay({ kind: "stash", root, index: s.index, oid: s.oid }) },
                    { label: "Apply", onClick: () => A.stashApply(root, s.index, false, s.oid) },
                    { label: "Pop (apply and delete)", onClick: () => A.stashApply(root, s.index, true, s.oid) },
                    { label: "Create branch from stash base…", onClick: () => A.createBranch(root, `${s.oid}^`, s.name) },
                    { separator: true },
                    { label: "Delete…", danger: true, icon: <Trash2 size={14} />, onClick: () => A.stashDrop(root, s.index, s.oid) },
                  ])
                }
              >
                <Archive size={13} style={{ flex: "none" }} />
                <span className="label">{s.message.replace(/^(WIP on|On) [^:]+:\s*/, "")}</span>
                <span className="meta">{relativeTime(s.time)}</span>
              </div>
            ))
            : empty("empty-stashes", "No stashes"),
        ),
        ...section(
          "submodules",
          "Submodules",
          extras?.submodules.length ?? 0,
          <Package size={12} />,
          <>
            {!!extras?.submodules.length && (
              <button className="icon-btn sm" title="Update all (init + recursive)" onClick={() => X.updateSubmodules(root)}>
                <RefreshCw size={12} />
              </button>
            )}
            <button className="icon-btn sm" title="Add submodule" onClick={() => X.addSubmodule(root)}>
              <Plus size={13} />
            </button>
          </>,
          extras?.submodules.length
            ? extras.submodules
                .filter((sm) => match(sm.path))
                .map((sm) => (
                  <div
                    key={`sm:${sm.path}`}
                    className="sb-item"
                    style={{ paddingLeft: 26 }}
                    title={[sm.path, sm.url ?? "", sm.oid + (sm.describe ? ` (${sm.describe})` : "")].join("\n")}
                    onDoubleClick={() => sm.state !== "uninitialized" && A.openRepoPath(joinPath(root, sm.path))}
                    onContextMenu={(e) =>
                      contextMenu(e, [
                        ...namePathMenu(sm.path, joinPath(root, sm.path)),
                        { separator: true },
                        { label: sm.state === "uninitialized" ? "Initialize and update" : "Update", icon: <RefreshCw size={14} />, onClick: () => X.updateSubmodules(root, [sm.path]) },
                        { label: "Open in a new tab", icon: <FolderGit2 size={14} />, disabled: sm.state === "uninitialized", onClick: () => A.openRepoPath(joinPath(root, sm.path)) },
                        { label: "Sync URLs", onClick: () => A.act(root, () => api.submoduleSync(root), { success: "Submodule URLs synced" }) },
                        { separator: true },
                        { label: "Copy URL", icon: <Copy size={14} />, disabled: !sm.url, onClick: () => copyText(sm.url ?? "", "URL copied") },
                        { label: "Show in folder", icon: <FolderOpen size={14} />, onClick: () => api.revealPath(joinPath(root, sm.path)) },
                      ])
                    }
                  >
                    <Package size={13} style={{ flex: "none" }} />
                    <span className="label">{sm.path}</span>
                    <span className="meta">
                      {sm.state === "uninitialized" && <span className="pill amber">not cloned</span>}
                      {sm.state === "modified" && <span className="pill blue">moved</span>}
                      {sm.state === "conflict" && <span className="pill red">conflict</span>}
                    </span>
                  </div>
                ))
            : empty("empty-submodules", "No submodules"),
        ),
        ...section(
          "worktrees",
          "Worktrees",
          extras?.worktrees.length ?? 0,
          <FolderGit2 size={12} />,
          <>
            <button className="icon-btn sm" title="Worktree manager" onClick={() => openOverlay({ kind: "worktrees", root })}><FolderGit2 size={13} /></button>
            <button className="icon-btn sm" title="Prune missing worktrees" onClick={() => X.pruneWorktrees(root)}>
              <Eraser size={12} />
            </button>
            <button className="icon-btn sm" title="New worktree" onClick={() => X.addWorktree(root)}>
              <Plus size={13} />
            </button>
          </>,
          (extras?.worktrees ?? [])
            .filter((w) => match(w.path) || match(w.branch ?? ""))
            .map((w) => (
              <div
                key={`wt:${w.path}`}
                className={`sb-item ${w.isCurrent ? "current" : ""}`}
                style={{ paddingLeft: 26 }}
                title={w.path}
                onDoubleClick={() => !w.isCurrent && A.openRepoPath(w.path)}
                onContextMenu={(e) =>
                  contextMenu(e, [
                    ...namePathMenu(basename(w.path), w.path, null),
                    { separator: true },
                    { label: "Open in a new tab", icon: <FolderGit2 size={14} />, disabled: w.isCurrent, onClick: () => A.openRepoPath(w.path) },
                    { label: "Show in folder", icon: <FolderOpen size={14} />, onClick: () => api.revealPath(w.path) },
                    { label: w.locked ? "Unlock" : "Lock", icon: <Lock size={14} />, disabled: w.isCurrent, onClick: () => X.lockWorktree(root, w.path, !w.locked) },
                    { separator: true },
                    { label: "Remove worktree…", icon: <Trash2 size={14} />, danger: true, disabled: w.isCurrent || w.locked, onClick: () => X.removeWorktree(root, w.path) },
                  ])
                }
              >
                <FolderGit2 size={13} style={{ flex: "none", color: w.isCurrent ? "var(--accent)" : undefined }} />
                <span className="label">{basename(w.path)}</span>
                <span className="meta">
                  {w.locked && <Lock size={11} />}
                  {w.prunable && <span className="pill red">missing</span>}
                  {w.branch ? <span onContextMenu={e => contextMenu(e, namePathMenu(w.branch!, w.path, `refs/heads/${w.branch}`))}>{w.branch}</span> : (w.detached ? "detached" : "")}
                </span>
              </div>
            )),
        ),
        ...(extras?.lfs
          ? section(
              "lfs",
              "Git LFS",
              extras.lfs.patterns.length,
              <HardDrive size={12} />,
              <>
                <button className="icon-btn sm" title="LFS files" onClick={() => X.lfsFilesDialog(root)}>
                  <Search size={12} />
                </button>
                <button className="icon-btn sm" title="Track a pattern" onClick={() => X.lfsTrack(root)}>
                  <Plus size={13} />
                </button>
              </>,
              !extras.lfs.available
                ? empty("lfs-missing", "Git LFS is not installed")
                : [
                    ...extras.lfs.patterns.map((pt) => (
                      <div
                        key={`lfs:${pt}`}
                        className="sb-item"
                        style={{ paddingLeft: 26 }}
                        onContextMenu={(e) => contextMenu(e, [{ label: `Stop tracking ${pt}`, icon: <Trash2 size={14} />, danger: true, onClick: () => X.lfsUntrack(root, pt) }])}
                      >
                        <HardDrive size={13} style={{ flex: "none" }} />
                        <span className="label mono">{pt}</span>
                      </div>
                    )),
                    <div key="lfs-actions" className="sb-item" style={{ paddingLeft: 26, gap: 4 }}>
                      <button className="btn sm ghost" onClick={() => X.lfsAction(root, "pull")}>
                        Pull
                      </button>
                      <button className="btn sm ghost" onClick={() => X.lfsAction(root, "fetch")}>
                        Fetch
                      </button>
                      <button className="btn sm ghost" onClick={() => X.lfsAction(root, "prune")}>
                        Prune
                      </button>
                    </div>,
                  ],
            )
          : []),
        ]}
      />
    </aside>
  );
}

const ROW_H = 27;
const HEAD_H = 32;

/** Renders only the visible sidebar rows (thousands of branches stay smooth). */
function VirtualRows({ rows }: { rows: ReactNode[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [viewH, setViewH] = useState(800);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const tops: number[] = [];
  let y = 4;
  for (const r of rows) {
    tops.push(y);
    y += String((r as ReactElement).key ?? "").startsWith("sec:") ? HEAD_H : ROW_H;
  }
  const from = scroll - 200;
  const to = scroll + viewH + 200;
  return (
    <div ref={ref} className="sb-scroll" onScroll={(e) => setScroll((e.target as HTMLDivElement).scrollTop)}>
      <div style={{ position: "relative", height: y + 12 }}>
        {rows.map((r, i) => {
          const isHead = String((r as ReactElement).key ?? "").startsWith("sec:");
          const h = isHead ? HEAD_H : ROW_H;
          if (tops[i] + h < from || tops[i] > to) return null;
          return (
            <div key={(r as ReactElement).key ?? i} style={{ position: "absolute", top: tops[i], left: 0, right: 0, height: h, display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
              {r}
            </div>
          );
        })}
      </div>
    </div>
  );
}
