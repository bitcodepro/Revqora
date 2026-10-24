import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Cloud,
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
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Server,
  Tag,
  Trash2,
} from "lucide-react";
import * as X from "../lib/extraActions";
import type { BranchInfo } from "../lib/types";
import { useRepos, type RepoTab } from "../lib/store";
import { contextMenu, copyText, openOverlay } from "../lib/ui";
import * as A from "../lib/actions";
import { api } from "../lib/api";
import { basename, joinPath, relativeTime } from "../lib/format";
import { AheadBehind } from "./bits";
import { branchMenu, tagMenu } from "./menus";
import { highlightBranch, jumpToCommit } from "./GraphView";
import { promptDialog } from "./dialogs";

interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  branch?: BranchInfo;
}

function buildTree(branches: BranchInfo[], strip = 0): TreeNode {
  const root: TreeNode = { name: "", path: "", children: new Map() };
  for (const b of branches) {
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

function sortedChildren(n: TreeNode): TreeNode[] {
  return [...n.children.entries()]
    .sort(([ka, a], [kb, b]) => {
      const da = ka.startsWith("d:") ? 0 : 1;
      const db = kb.startsWith("d:") ? 0 : 1;
      return da - db || a.name.localeCompare(b.name);
    })
    .map(([, v]) => v);
}

export function Sidebar({ tab }: { tab: RepoTab }) {
  const root = tab.root;
  const [filter, setFilter] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ tags: true });
  const [openDirs, setOpenDirs] = useState<Record<string, boolean>>({});
  const refs = tab.refs;
  const extras = tab.extras;
  const f = filter.trim().toLowerCase();
  const match = (s: string) => !f || s.toLowerCase().includes(f);
  const current = tab.info?.head.branch;

  const local = useMemo(() => (refs?.local ?? []).filter((b) => match(b.name)), [refs, f]); // eslint-disable-line react-hooks/exhaustive-deps
  const remoteByName = useMemo(() => {
    const m = new Map<string, BranchInfo[]>();
    for (const r of refs?.remotes ?? []) m.set(r.name, []);
    for (const b of refs?.remote ?? []) {
      if (!match(b.name)) continue;
      const k = b.remote ?? "origin";
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(b);
    }
    return m;
  }, [refs, f]); // eslint-disable-line react-hooks/exhaustive-deps
  const tags = (refs?.tags ?? []).filter((t) => match(t.name));
  const stashes = (refs?.stashes ?? []).filter((s) => match(s.message));

  const toggle = (k: string) => setCollapsed((c) => ({ ...c, [k]: !c[k] }));
  const isOpen = (k: string) => (f ? true : openDirs[k] ?? true);

  const renderTree = (node: TreeNode, kind: "local" | "remote", depth: number, prefix: string): ReactNode[] =>
    sortedChildren(node).flatMap((n) => {
      const pad = 10 + depth * 14;
      if (n.branch) {
        const b = n.branch;
        const isCur = kind === "local" && b.name === current;
        return [
          <div
            key={b.fullName}
            className={`sb-item ${isCur ? "current" : ""}`}
            style={{ paddingLeft: pad + 16 }}
            title={`${b.name}\n${b.subject}\n${b.author} · ${relativeTime(b.time)}${b.upstream ? `\ntracks ${b.upstream}` : ""}`}
            onClick={() => jumpToCommit(root, b.oid)}
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
            onDoubleClick={() => !isCur && A.checkout(root, b.name, kind)}
            onContextMenu={(e) =>
              contextMenu(e, [
                ...branchMenu(root, b.name, kind),
                { separator: true },
                {
                  label: "Show only this branch in graph",
                  icon: <Eye size={14} />,
                  onClick: () => {
                    useRepos.getState().patch(root, { branchFilter: b.name });
                    useRepos.getState().refresh(root, { graph: true });
                  },
                },
              ])
            }
          >
            {kind === "local" ? <GitBranch size={13} style={{ flex: "none", color: isCur ? "var(--accent)" : undefined }} /> : <Cloud size={13} style={{ flex: "none" }} />}
            <span className="label">{n.name}</span>
            <span className="meta">
              {b.gone && <span className="pill red">gone</span>}
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
    <div key={`sec:${id}`} className={`sb-section-head ${collapsed[id] ? "collapsed" : ""}`} onClick={() => toggle(id)}>
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

  return (
    <aside className="sidebar">
      <div className="sb-repo">
        <div className="input-wrap">
          <Search size={13} />
          <input className="input sm" placeholder="Filter branches, tags, stashes" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
      </div>
      <VirtualRows
        rows={[
        ...section(
          "local",
          "Branches",
          refs?.local.length ?? 0,
          <GitBranch size={12} />,
          <button className="icon-btn sm" title="New branch" onClick={() => A.createBranch(root, null, current ?? "HEAD")}>
            <Plus size={13} />
          </button>,
          local.length ? renderTree(buildTree(local), "local", 0, "") : empty("empty-local", f ? "No matches" : "No branches yet"),
        ),
        ...section(
          "remotes",
          "Remotes",
          refs?.remote.length ?? 0,
          <Globe size={12} />,
          <button className="icon-btn sm" title="Add remote" onClick={() => A.addRemote(root)}>
            <Plus size={13} />
          </button>,
          remoteByName.size === 0
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
                  ...(open ? renderTree(buildTree(list, 1), "remote", 1, name + "/") : []),
              ];
            }),
        ),
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
                onClick={() => openOverlay({ kind: "stash", root, index: s.index })}
                onDoubleClick={() => A.stashApply(root, s.index, false)}
                onContextMenu={(e) =>
                  contextMenu(e, [
                    { label: "Show contents", onClick: () => openOverlay({ kind: "stash", root, index: s.index }) },
                    { label: "Apply", onClick: () => A.stashApply(root, s.index, false) },
                    { label: "Pop (apply and delete)", onClick: () => A.stashApply(root, s.index, true) },
                    { label: "Create branch from stash base…", onClick: () => A.createBranch(root, `${s.oid}^`, s.name) },
                    { separator: true },
                    { label: "Delete…", danger: true, icon: <Trash2 size={14} />, onClick: () => A.stashDrop(root, s.index) },
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
            <button className="icon-btn sm" title="Prune missing worktrees" onClick={() => A.act(root, () => api.worktreePrune(root), { success: "Worktrees pruned" })}>
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
                    { label: "Open in a new tab", icon: <FolderGit2 size={14} />, disabled: w.isCurrent, onClick: () => A.openRepoPath(w.path) },
                    { label: "Show in folder", icon: <FolderOpen size={14} />, onClick: () => api.revealPath(w.path) },
                    { label: w.locked ? "Unlock" : "Lock", icon: <Lock size={14} />, disabled: w.isCurrent, onClick: () => A.act(root, () => api.worktreeLock(root, w.path, !w.locked)) },
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
                  {w.branch ?? (w.detached ? "detached" : "")}
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
