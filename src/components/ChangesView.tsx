import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  CloudUpload,
  Copy,
  ExternalLink,
  FolderOpen,
  GitMerge,
  History,
  Layers,
  ListPlus,
  Merge,
  Minus,
  MoreHorizontal,
  Pencil,
  Plus,
  Swords,
  Trash2,
  Undo2,
  Info,
  Combine,
  Sparkles,
  ScanSearch,
  List,
  FolderTree,
  HardDrive,
} from "lucide-react";
import { api, errorMessage, isGitError } from "../lib/api";
import { useRepos, type ChangeSel, type RepoTab } from "../lib/store";
import { useSettings } from "../lib/settings";
import { contextMenu, copyText, openOverlay, showDialog, toast, type MenuItem } from "../lib/ui";
import * as A from "../lib/actions";
import type { CommitHelpers, FileDiff, FileStatus, GitError, LargeFile, LayerConflict, LayerOp, LayerView } from "../lib/types";
import { MergeEditor } from "./ConflictEditor";
import { conflictLabel, joinPath, plural, relativeTime } from "../lib/format";
import { FileGroups, PathLabel, StatusIcon } from "./bits";
import { DiffView, useDiffOpts, type LineAction } from "./DiffView";
import { confirmDialog, identityDialog, promptDialog } from "./dialogs";
import { Modal } from "./Modal";
import { fileHistoryDialog } from "./FileHistory";
import { Splitter } from "./Overlays";

const LAYER_COLORS = [0, 1, 2, 3, 5, 6, 8, 9];
const layerColor = (i: number) => `var(--lane-${LAYER_COLORS[i % LAYER_COLORS.length]})`;

// ───────────── layer actions ─────────────

/**
 * Runs a layer action. When it replays layers (`op`) and they overlap, offers to resolve the
 * overlapping changes in the merge editor and retries with those resolutions.
 */
async function layerAct(root: string, fn: (res?: Record<string, string>) => Promise<unknown>, success?: string, op?: LayerOp) {
  try {
    await fn();
    if (success) toast.success(success);
    return true;
  } catch (e) {
    if (isGitError(e) && e.kind === "layer-conflict") {
      if (!op) {
        await confirmDialog({
          title: "Layers depend on each other",
          message: `${e.message} Merge the layers, or change the later layer first.`,
          confirm: "OK",
          icon: <Layers size={18} />,
          details: e.details,
        });
        return false;
      }
      const go = await confirmDialog({
        title: "Layers depend on each other",
        message: `${e.message} You can decide by hand how the later changes should look without the earlier ones.`,
        confirm: "Resolve…",
        icon: <Layers size={18} />,
        details: e.details,
      });
      if (!go) return false;
      const res = await resolveLayerConflicts(root, op);
      if (!res) return false;
      try {
        await fn(res);
        if (success) toast.success(success);
        return true;
      } catch (e2) {
        toast.error(e2);
        return false;
      }
    }
    toast.error(e);
    return false;
  } finally {
    await useRepos.getState().refresh(root, { status: true, layers: true });
  }
}

/** Walks the user through every conflicting file; returns the resolutions, or null if cancelled. */
async function resolveLayerConflicts(root: string, op: LayerOp): Promise<Record<string, string> | null> {
  const res: Record<string, string> = {};
  for (let guard = 0; guard < 50; guard++) {
    let conflict: LayerConflict | null;
    try {
      conflict = await api.layerPreview(root, op, res);
    } catch (e) {
      toast.error(e);
      return null;
    }
    if (!conflict) return res;
    for (let i = 0; i < conflict.files.length; i++) {
      const info = conflict.files[i];
      const text = await showDialog<string | null>((close) => (
        <div style={{ position: "fixed", inset: 0, zIndex: 880, background: "var(--bg)" }}>
          <MergeEditor
            path={info.path}
            info={info}
            position={`${conflict!.label} · file ${i + 1} of ${conflict!.files.length}`}
            saveLabel="Use this result"
            onClose={() => close(null)}
            onSave={async (t) => close(t)}
            onTake={async (which) => {
              if (which === "delete") throw new Error("Deleting a file is not supported while resolving layers.");
              close(which === "ours" ? info.ours.text : info.theirs.text);
            }}
          />
        </div>
      ));
      if (text === null) return null;
      res[`${conflict.item}:${info.path}`] = text;
    }
  }
  return null;
}

function layerMenu(root: string, l: LayerView, total: number): MenuItem[] {
  return [
    { label: "Unstage layer", icon: <Minus size={14} />, onClick: () => layerAct(root, (res) => api.layerUnstage(root, l.index, res), `${l.name} unstaged`, { op: "unstage", index: l.index }) },
    {
      label: "Discard layer…",
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: async () => {
        const ok = await confirmDialog({
          title: `Discard ${l.name}?`,
          message: "These changes are removed from the index and from your working files. A backup is kept in .git/revqora/trash.",
          confirm: "Discard layer",
          danger: true,
          details: l.files.map((f) => f.path),
        });
        if (ok) await layerAct(root, () => api.layerDiscard(root, l.index), `${l.name} discarded`);
      },
    },
    { separator: true },
    { label: "Commit this layer…", icon: <Check size={14} />, onClick: () => commitLayer(root, l, false) },
    ...(l.index > 0 ? [{ label: `Commit layers 1–${l.index + 1}…`, icon: <Combine size={14} />, onClick: () => commitLayer(root, l, true) }] : []),
    { separator: true },
    { label: "Merge into layer below", icon: <Merge size={14} />, disabled: l.index === 0, onClick: () => layerAct(root, () => api.layerMergeDown(root, l.index)) },
    { label: "Move up", icon: <ArrowUp size={14} />, disabled: l.index === 0, onClick: () => layerAct(root, (res) => api.layerMove(root, l.index, -1, res), undefined, { op: "move", index: l.index, delta: -1 }) },
    { label: "Move down", icon: <ArrowDown size={14} />, disabled: l.index >= total - 1, onClick: () => layerAct(root, (res) => api.layerMove(root, l.index, 1, res), undefined, { op: "move", index: l.index, delta: 1 }) },
    {
      label: "Rename…",
      icon: <Pencil size={14} />,
      onClick: async () => {
        const n = await promptDialog({ title: "Rename layer", initial: l.name, confirm: "Rename" });
        if (n) await layerAct(root, () => api.layerRename(root, l.index, n));
      },
    },
  ];
}

async function commitLayer(root: string, l: LayerView, through: boolean) {
  const msg = await promptDialog({
    title: through ? `Commit layers 1–${l.index + 1}` : `Commit ${l.name}`,
    label: "Commit message",
    initial: l.name.startsWith("Layer ") ? "" : l.name,
    multiline: true,
    confirm: "Commit",
    help: "Only this layer's changes go into the commit; the other layers stay staged.",
  });
  if (!msg) return;
  await layerAct(root, (res) => api.layerCommit(root, l.index, msg, through, undefined, res), "Committed", through ? undefined : { op: "commitLayer", index: l.index });
  await useRepos.getState().refresh(root);
}

function dragFile(e: React.DragEvent, from: "unstaged" | "staged", path: string) {
  e.dataTransfer.setData("revqora/file", JSON.stringify({ from, path }));
  e.dataTransfer.effectAllowed = "move";
}

// ───────────── component ─────────────

export function ChangesView({ tab, onOpenConflict }: { tab: RepoTab; onOpenConflict: (path: string) => void }) {
  const root = tab.root;
  const patch = useRepos((s) => s.patch);
  const width = useSettings((s) => s.changesListWidth);
  const setSettings = useSettings((s) => s.set);
  const opts = useDiffOpts();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const [diffErr, setDiffErr] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [w, setW] = useState(width);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const treeView = useSettings((s) => s.fileView) === "tree";

  const files = tab.status?.files ?? [];
  const conflicts = files.filter((f) => f.conflict);
  const unstaged = files.filter((f) => !f.conflict && f.worktree !== ".");
  const staged = files.filter((f) => !f.conflict && f.index !== ".");
  const layers = tab.layers?.active ? tab.layers : null;
  const sel = tab.changeSel;

  // Keep the selection valid as files move between lists.
  useEffect(() => {
    if (!sel) {
      const first = conflicts[0] ? ({ kind: "conflict", path: conflicts[0].path } as ChangeSel) : unstaged[0] ? ({ kind: "unstaged", path: unstaged[0].path, untracked: unstaged[0].untracked } as ChangeSel) : null;
      if (first) patch(root, { changeSel: first });
      return;
    }
    const exists =
      sel.kind === "conflict"
        ? conflicts.some((f) => f.path === sel.path)
        : sel.kind === "unstaged"
          ? unstaged.some((f) => f.path === sel.path)
          : sel.kind === "staged"
            ? layers
              ? layers.openFiles.some((f) => f.path === sel.path)
              : staged.some((f) => f.path === sel.path)
            : !!layers?.layers[sel.layer]?.files.some((f) => f.path === sel.path);
    if (exists) return;
    const u = unstaged.find((f) => f.path === sel.path);
    const s = layers ? layers.openFiles.find((f) => f.path === sel.path) : staged.find((f) => f.path === sel.path);
    let next: ChangeSel | null = null;
    if (sel.kind !== "unstaged" && u) next = { kind: "unstaged", path: u.path, untracked: u.untracked };
    else if (sel.kind !== "staged" && s) next = { kind: "staged", path: s.path };
    else if (unstaged[0]) next = { kind: "unstaged", path: unstaged[0].path, untracked: unstaged[0].untracked };
    else if (conflicts[0]) next = { kind: "conflict", path: conflicts[0].path };
    patch(root, { changeSel: next });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.status, tab.layers]);

  const loadDiff = useCallback(async () => {
    if (!sel || sel.kind === "conflict") {
      setDiff(null);
      return;
    }
    setDiffLoading(true);
    setDiffErr(null);
    try {
      let d: FileDiff;
      if (sel.kind === "unstaged") d = await api.workingDiff(root, sel.path, "unstaged", sel.untracked, opts);
      else if (sel.kind === "staged") d = await api.workingDiff(root, sel.path, "staged", false, opts);
      else {
        const l = layers?.layers[sel.layer];
        if (!l) return;
        d = await api.revDiff(root, l.fromTree, l.toTree, sel.path, opts);
      }
      setDiff(d);
    } catch (e) {
      setDiffErr(errorMessage(e));
      setDiff(null);
    } finally {
      setDiffLoading(false);
    }
  }, [root, sel, opts, layers]);

  // Reload the diff when the selection or the repository state changes.
  const statusKey = useMemo(() => JSON.stringify(tab.status?.files.map((f) => f.path + f.index + f.worktree)) + (tab.layers?.stagedBase ?? ""), [tab.status, tab.layers]);
  const watchTick = useRef(0);
  useEffect(() => {
    loadDiff();
  }, [loadDiff, statusKey]);
  useEffect(() => {
    const onChange = (e: Event) => {
      const d = (e as CustomEvent).detail as { repo: string };
      if (d.repo === root) {
        watchTick.current++;
        loadDiff();
      }
    };
    window.addEventListener("revqora:worktree", onChange);
    return () => window.removeEventListener("revqora:worktree", onChange);
  }, [root, loadDiff]);

  const select = (s: ChangeSel) => patch(root, { changeSel: s });

  const onApply = async (selection: [number, number][], action: LineAction) => {
    if (!diff || !sel || (sel.kind !== "unstaged" && sel.kind !== "staged") || action === "apply") return;
    if (action === "discard" && useSettings.getState().confirmDiscard) {
      const ok = await confirmDialog({ title: "Discard selected lines?", message: "The selected changes are removed from your working file.", confirm: "Discard", danger: true });
      if (!ok) return;
    }
    try {
      await api.applySelection(root, sel.path, action, selection, diff.hash, sel.kind === "unstaged" && sel.untracked, opts);
    } catch (e) {
      toast.error(e);
    }
    await useRepos.getState().refresh(root, { status: true, layers: true });
    await loadDiff();
  };

  const fileMenu = (f: FileStatus, kind: "unstaged" | "staged"): MenuItem[] => [
    ...(kind === "unstaged"
      ? [
          { label: "Stage", icon: <Plus size={14} />, onClick: () => A.stagePaths(root, [f.path]) },
          { label: "Stage into a new layer", icon: <ListPlus size={14} />, onClick: () => A.stageAsNewLayer(root, [f.path]) },
          { label: "Discard changes…", icon: <Undo2 size={14} />, danger: true, onClick: () => A.discardPaths(root, f.untracked ? [] : [f.path], f.untracked ? [f.path] : []) },
        ]
      : [{ label: "Unstage", icon: <Minus size={14} />, onClick: () => A.unstagePaths(root, [f.path]) }]),
    { label: "Stash this file", icon: <Archive size={14} />, onClick: () => A.act(root, () => api.stashSave(root, `Stash ${f.path}`, true, false, [f.path]), { success: "File stashed" }) },
    { separator: true },
    { label: "File history", icon: <History size={14} />, disabled: f.untracked, onClick: () => fileHistoryDialog(root, f.path) },
    { label: "Blame", icon: <ScanSearch size={14} />, disabled: f.untracked || f.worktree === "D", onClick: () => openOverlay({ kind: "blame", root, path: f.path, rev: null }) },
    { label: "Open file", icon: <ExternalLink size={14} />, onClick: () => api.openPath(joinPath(root, f.path)) },
    { label: "Show in folder", icon: <FolderOpen size={14} />, onClick: () => api.revealPath(joinPath(root, f.path)) },
    { label: "Copy path", icon: <Copy size={14} />, onClick: () => copyText(f.path, "Path copied") },
  ];

  // Files dragged onto the Staged header are staged, onto the Unstaged header unstaged.
  const dropProps = (id: string) =>
    id === "staged" || id === "unstaged"
      ? {
          onDragOver: (e: React.DragEvent) => {
            if (!e.dataTransfer.types.includes("revqora/file")) return;
            e.preventDefault();
            setDropOn(id);
          },
          onDragLeave: () => setDropOn(null),
          onDrop: (e: React.DragEvent) => {
            setDropOn(null);
            const raw = e.dataTransfer.getData("revqora/file");
            if (!raw) return;
            const d = JSON.parse(raw) as { from: string; path: string };
            if (id === "staged" && d.from === "unstaged") A.stagePaths(root, [d.path]);
            if (id === "unstaged" && d.from === "staged") A.unstagePaths(root, [d.path]);
          },
        }
      : {};
  const head = (id: string, title: string, count: number, actions?: ReactNode) => (
    <div className={`cg-head ${collapsed[id] ? "collapsed" : ""} ${dropOn === id ? "drop-on" : ""}`} onClick={() => setCollapsed((c) => ({ ...c, [id]: !c[id] }))} {...dropProps(id)}>
      <ChevronDown size={14} className="chev" />
      <span className="t">{title}</span>
      <span className="pill">{count}</span>
      <div className="actions" onClick={(e) => e.stopPropagation()}>
        {actions}
      </div>
    </div>
  );

  const stageNewLayerAll = () => A.stageAsNewLayer(root, unstaged.map((f) => f.path));
  const discardAll = () =>
    A.discardPaths(
      root,
      unstaged.filter((f) => !f.untracked).map((f) => f.path),
      unstaged.filter((f) => f.untracked).map((f) => f.path),
    );

  const selectedIs = (kind: ChangeSel["kind"], path: string, layer?: number) =>
    !!sel && sel.kind === kind && sel.path === path && (kind !== "layer" || (sel.kind === "layer" && sel.layer === layer));

  const diffMode = sel?.kind === "unstaged" ? "unstaged" : sel?.kind === "staged" ? "staged" : "readonly";
  const diffActions = sel && sel.kind !== "conflict" && (
    <>
      {sel.kind === "unstaged" && (
        <>
          <button className="btn sm" onClick={() => A.stagePaths(root, [sel.path])}>
            <Plus size={12} /> Stage file
          </button>
          <button className="btn sm ghost" onClick={() => A.discardPaths(root, sel.untracked ? [] : [sel.path], sel.untracked ? [sel.path] : [])} title="Discard file">
            <Undo2 size={13} />
          </button>
        </>
      )}
      {sel.kind === "staged" && (
        <button className="btn sm" onClick={() => A.unstagePaths(root, [sel.path])}>
          <Minus size={12} /> Unstage file
        </button>
      )}
      {sel.kind === "layer" && (
        <button className="btn sm" onClick={() => layerAct(root, () => api.layerUnstageFiles(root, sel.layer, [sel.path]), "Removed from layer")}>
          <Minus size={12} /> Remove from layer
        </button>
      )}
    </>
  );

  const conflictSel = sel?.kind === "conflict" ? conflicts.find((f) => f.path === sel.path) : undefined;

  return (
    <div className="changes" style={{ ["--changes-w" as string]: `${w}px` }}>
      <div className="changes-left">
        <div className="changes-lists">
          <div className="hstack" style={{ justifyContent: "flex-end", padding: "4px 4px 0" }}>
            <div className="seg">
              <button className={!treeView ? "on" : ""} title="Flat list" onClick={() => useSettings.getState().set({ fileView: "list" })}>
                <List size={12} />
              </button>
              <button className={treeView ? "on" : ""} title="Group by folder" onClick={() => useSettings.getState().set({ fileView: "tree" })}>
                <FolderTree size={12} />
              </button>
            </div>
          </div>
          {conflicts.length > 0 && (
            <>
              {head(
                "conflicts",
                "Conflicts",
                conflicts.length,
                <button className="btn sm warn" onClick={() => onOpenConflict(conflicts[0].path)}>
                  <Swords size={12} /> Resolve
                </button>,
              )}
              {!collapsed.conflicts &&
                conflicts.map((f) => (
                  <div
                    key={f.path}
                    className={`file-row ${selectedIs("conflict", f.path) ? "selected" : ""}`}
                    onClick={() => select({ kind: "conflict", path: f.path })}
                    onDoubleClick={() => onOpenConflict(f.path)}
                    onContextMenu={(e) =>
                      contextMenu(e, [
                        { label: "Open merge editor", icon: <Swords size={14} />, onClick: () => onOpenConflict(f.path) },
                        { label: "Take ours (current branch)", icon: <ArrowUp size={14} />, onClick: () => A.act(root, () => api.conflictTake(root, f.path, "ours"), { success: "Resolved with ours" }) },
                        { label: "Take theirs (incoming)", icon: <ArrowDown size={14} />, onClick: () => A.act(root, () => api.conflictTake(root, f.path, "theirs"), { success: "Resolved with theirs" }) },
                        { label: "Mark as resolved", icon: <Check size={14} />, onClick: () => A.act(root, () => api.conflictMarkResolved(root, [f.path]), { success: "Marked resolved" }) },
                        { separator: true },
                        { label: "Open file", icon: <ExternalLink size={14} />, onClick: () => api.openPath(joinPath(root, f.path)) },
                      ])
                    }
                  >
                    <StatusIcon code="U" />
                    <PathLabel path={f.path} />
                    <span className="pill red" style={{ marginLeft: "auto" }}>
                      {conflictLabel(f.conflict)}
                    </span>
                  </div>
                ))}
            </>
          )}

          {head(
            "unstaged",
            "Unstaged",
            unstaged.length,
            unstaged.length > 0 && (
              <>
                <button className="icon-btn sm" title="Stash all changes" onClick={() => A.stash(root)}>
                  <Archive size={13} />
                </button>
                <button className="icon-btn sm" title="Discard all…" onClick={discardAll}>
                  <Undo2 size={13} />
                </button>
                <button className="icon-btn sm" title="Stage all into a new layer" onClick={stageNewLayerAll}>
                  <ListPlus size={14} />
                </button>
                <button className="btn sm" title="Stage all" onClick={() => A.stagePaths(root, unstaged.map((f) => f.path))}>
                  <Plus size={12} /> Stage all
                </button>
              </>
            ),
          )}
          {!collapsed.unstaged && unstaged.length === 0 && <div className="cg-empty">No unstaged changes.</div>}
          {!collapsed.unstaged &&
            <FileGroups items={unstaged} tree={treeView} idPrefix="u" render={(f, grouped) => (
              <div
                key={f.path}
                className={`file-row ${selectedIs("unstaged", f.path) ? "selected" : ""}`}
                onClick={() => select({ kind: "unstaged", path: f.path, untracked: f.untracked })}
                onDoubleClick={() => A.stagePaths(root, [f.path])}
                draggable
                onDragStart={(e) => dragFile(e, "unstaged", f.path)}
                onContextMenu={(e) => contextMenu(e, fileMenu(f, "unstaged"))}
                title={f.path}
              >
                <StatusIcon code={f.untracked ? "?" : f.worktree} />
                <PathLabel path={f.path} hideDir={grouped} />
                <div className="row-actions">
                  <button className="icon-btn sm" title="Discard" onClick={(e) => (e.stopPropagation(), A.discardPaths(root, f.untracked ? [] : [f.path], f.untracked ? [f.path] : []))}>
                    <Undo2 size={13} />
                  </button>
                  <button className="icon-btn sm" title="Stage into a new layer" onClick={(e) => (e.stopPropagation(), A.stageAsNewLayer(root, [f.path]))}>
                    <ListPlus size={14} />
                  </button>
                  <button className="icon-btn sm" title="Stage" onClick={(e) => (e.stopPropagation(), A.stagePaths(root, [f.path]))}>
                    <Plus size={14} />
                  </button>
                </div>
              </div>
            )} />}

          {head(
            "staged",
            layers ? "Staged · layers" : "Staged",
            layers ? layers.layers.reduce((a, l) => a + l.files.length, 0) + layers.openFiles.length : staged.length,
            <>
              {(layers ? layers.openFiles.length > 0 : staged.length > 0) && (
                <button className="icon-btn sm" title="Seal what is staged now into a layer — new staging goes on top" onClick={() => layerAct(root, () => api.layerSeal(root, null), "Layer created")}>
                  <Layers size={14} />
                </button>
              )}
              {layers && (
                <button
                  className="icon-btn sm"
                  title="Layer options"
                  onClick={(e) =>
                    contextMenu(e, [
                      { label: "Merge all layers into one", icon: <Combine size={14} />, onClick: () => layerAct(root, () => api.layersFlatten(root), "Layers merged") },
                      { label: "Unstage everything", icon: <Minus size={14} />, onClick: () => A.unstagePaths(root, staged.map((f) => f.path)).then(() => layerAct(root, () => api.layersFlatten(root))) },
                    ])
                  }
                >
                  <MoreHorizontal size={14} />
                </button>
              )}
              {!layers && staged.length > 0 && (
                <button className="btn sm" onClick={() => A.unstagePaths(root, staged.map((f) => f.path))}>
                  <Minus size={12} /> Unstage all
                </button>
              )}
            </>,
          )}
          {!collapsed.staged && !layers && staged.length === 0 && <div className="cg-empty">Nothing staged. Double-click a file or use + to stage it.</div>}
          {!collapsed.staged &&
            !layers &&
            <FileGroups items={staged} tree={treeView} idPrefix="s" render={(f, grouped) => (
              <div
                key={f.path}
                className={`file-row ${selectedIs("staged", f.path) ? "selected" : ""}`}
                onClick={() => select({ kind: "staged", path: f.path })}
                onDoubleClick={() => A.unstagePaths(root, [f.path])}
                draggable
                onDragStart={(e) => dragFile(e, "staged", f.path)}
                onContextMenu={(e) => contextMenu(e, fileMenu(f, "staged"))}
                title={f.origPath ? `${f.origPath} → ${f.path}` : f.path}
              >
                <StatusIcon code={f.index} />
                <PathLabel path={f.path} hideDir={grouped} />
                <div className="row-actions">
                  <button className="icon-btn sm" title="Unstage" onClick={(e) => (e.stopPropagation(), A.unstagePaths(root, [f.path]))}>
                    <Minus size={14} />
                  </button>
                </div>
              </div>
            )} />}
          {!collapsed.staged && !layers && staged.length > 0 && (
            <div className="layer-hint">
              <Sparkles size={15} style={{ color: "var(--accent)", flex: "none", marginTop: 1 }} />
              <div>
                <b>Stage layers:</b> press <Layers size={12} style={{ verticalAlign: -2 }} /> to seal what is staged now into a layer. Later staging goes into a new layer on top, and each
                layer can be unstaged, discarded or committed on its own.
              </div>
            </div>
          )}
          {!collapsed.staged &&
            layers &&
            layers.layers.map((l) => (
              <div className="layer" key={l.index} style={{ ["--layer-c" as string]: layerColor(l.index) }} onContextMenu={(e) => contextMenu(e, layerMenu(root, l, layers.layers.length))}>
                <div className="layer-head">
                  <span className="layer-badge">{l.index + 1}</span>
                  <span className="ln" title={l.name}>
                    {l.name}
                  </span>
                  <span className="lt">
                    {plural(l.files.length, "file")} · {relativeTime(l.created)}
                  </span>
                  <div className="actions">
                    <button className="icon-btn sm" title="Unstage layer" onClick={() => layerAct(root, (res) => api.layerUnstage(root, l.index, res), `${l.name} unstaged`, { op: "unstage", index: l.index })}>
                      <Minus size={14} />
                    </button>
                    <button className="icon-btn sm" title="More" onClick={(e) => contextMenu(e, layerMenu(root, l, layers.layers.length))}>
                      <MoreHorizontal size={14} />
                    </button>
                  </div>
                </div>
                <div className="layer-files">
                  {l.files.map((f) => (
                    <div
                      key={f.path}
                      className={`file-row ${selectedIs("layer", f.path, l.index) ? "selected" : ""}`}
                      onClick={() => select({ kind: "layer", layer: l.index, path: f.path })}
                      onContextMenu={(e) =>
                        contextMenu(e, [
                          { label: "Remove from this layer", icon: <Minus size={14} />, onClick: () => layerAct(root, () => api.layerUnstageFiles(root, l.index, [f.path]), "Removed from layer") },
                          { separator: true },
                          { label: "Copy path", icon: <Copy size={14} />, onClick: () => copyText(f.path, "Path copied") },
                        ])
                      }
                    >
                      <StatusIcon code={f.status} />
                      <PathLabel path={f.path} />
                      <div className="row-actions">
                        <button className="icon-btn sm" title="Remove from layer" onClick={(e) => (e.stopPropagation(), layerAct(root, () => api.layerUnstageFiles(root, l.index, [f.path])))}>
                          <Minus size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          {!collapsed.staged && layers && (
            <div className="layer open-layer" style={{ ["--layer-c" as string]: layerColor(layers.layers.length) }}>
              <div className="layer-head">
                <span className="layer-badge">{layers.layers.length + 1}</span>
                <span className="ln">New staging</span>
                <span className="lt">open · stage actions go here</span>
                <div className="actions">
                  {layers.openFiles.length > 0 && (
                    <>
                      <button className="icon-btn sm" title="Seal into a layer" onClick={() => layerAct(root, () => api.layerSeal(root, null), "Layer created")}>
                        <Layers size={14} />
                      </button>
                      <button className="icon-btn sm" title="Unstage all of this" onClick={() => layerAct(root, (res) => api.layerUnstage(root, layers.layers.length, res), undefined, { op: "unstage", index: layers.layers.length })}>
                        <Minus size={14} />
                      </button>
                    </>
                  )}
                </div>
              </div>
              <div className="layer-files">
                {layers.openFiles.length === 0 && <div className="cg-empty">Empty — stage files to add them here.</div>}
                {layers.openFiles.map((f) => (
                  <div
                    key={f.path}
                    className={`file-row ${selectedIs("staged", f.path) ? "selected" : ""}`}
                    onClick={() => select({ kind: "staged", path: f.path })}
                    onDoubleClick={() => A.unstagePaths(root, [f.path])}
                    draggable
                    onDragStart={(e) => dragFile(e, "staged", f.path)}
                  >
                    <StatusIcon code={f.status} />
                    <PathLabel path={f.path} />
                    <div className="row-actions">
                      <button className="icon-btn sm" title="Unstage" onClick={(e) => (e.stopPropagation(), A.unstagePaths(root, [f.path]))}>
                        <Minus size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {tab.layers?.note && (
            <div className="callout warn" style={{ margin: "6px 4px" }}>
              <Info size={15} />
              <div>{tab.layers.note}</div>
            </div>
          )}
        </div>
        <CommitBox tab={tab} stagedCount={staged.length} />
      </div>
      <Splitter
        dir="v"
        style={{ left: w }}
        onDrag={(d) => setW((x) => Math.max(260, Math.min(720, x + d)))}
        onEnd={() => setSettings({ changesListWidth: w })}
      />
      {conflictSel ? (
        <ConflictSummary root={root} file={conflictSel} onOpen={() => onOpenConflict(conflictSel.path)} />
      ) : (
        <DiffView
          diff={diff}
          loading={diffLoading}
          error={diffErr}
          mode={diffMode}
          path={sel?.path ?? ""}
          actions={diffActions}
          onApply={onApply}
          root={root}
          images={
            !sel || sel.kind === "conflict"
              ? undefined
              : sel.kind === "unstaged"
                ? { old: sel.untracked ? null : { rev: `:${sel.path}` }, new: { worktree: sel.path } }
                : sel.kind === "staged"
                  ? { old: { rev: `${tab.layers?.stagedBase ?? "HEAD"}:${sel.path}` }, new: { rev: `:${sel.path}` } }
                  : layers?.layers[sel.layer]
                    ? { old: { rev: `${layers.layers[sel.layer].fromTree}:${sel.path}` }, new: { rev: `${layers.layers[sel.layer].toTree}:${sel.path}` } }
                    : undefined
          }
          badge={sel?.kind === "layer" ? <span className="pill accent">Layer {sel.layer + 1}</span> : sel?.kind === "staged" ? <span className="pill green">staged</span> : null}
          emptyText={files.length ? "Select a file to see its changes" : "Working tree clean — nothing to commit"}
        />
      )}
    </div>
  );
}


function ConflictSummary({ root, file, onOpen }: { root: string; file: FileStatus; onOpen: () => void }) {
  return (
    <div className="diff">
      <div className="empty">
        <div className="big" style={{ color: "var(--red)" }}>
          <Swords size={26} />
        </div>
        <h3>{file.path}</h3>
        <div>{conflictLabel(file.conflict)} — this file needs your decision before the operation can be completed.</div>
        <div className="hstack" style={{ marginTop: 8, flexWrap: "wrap", justifyContent: "center" }}>
          <button className="btn primary lg" onClick={onOpen}>
            <Swords size={16} /> Open merge editor
          </button>
          <button className="btn lg" onClick={() => A.act(root, () => api.conflictTake(root, file.path, "ours"), { success: "Resolved with ours" })}>
            Take ours
          </button>
          <button className="btn lg" onClick={() => A.act(root, () => api.conflictTake(root, file.path, "theirs"), { success: "Resolved with theirs" })}>
            Take theirs
          </button>
        </div>
      </div>
    </div>
  );
}

// ───────────── commit box ─────────────

const drafts = new Map<string, { summary: string; body: string }>();
/** Messages Revqora filled in for a merge / cherry-pick, removed again when it ends. */
const prefilledMessages = new Map<string, { summary: string; body: string }>();

function CommitBox({ tab, stagedCount }: { tab: RepoTab; stagedCount: number }) {
  const root = tab.root;
  const state = tab.info?.state;
  const kind = state?.kind ?? "none";
  const draft = drafts.get(root) ?? { summary: "", body: "" };
  const [summary, setSummary] = useState(draft.summary);
  const [body, setBody] = useState(draft.body);
  const [amend, setAmend] = useState(false);
  const [signOff, setSignOff] = useState(false);
  const [noVerify, setNoVerify] = useState(false);
  const [sign, setSign] = useState(false);
  const [helpers, setHelpers] = useState<CommitHelpers | null>(null);
  const conventional = useSettings((s) => s.conventionalCommits);
  const [ccType, setCcType] = useState("feat");
  const [ccScope, setCcScope] = useState("");
  const [ccBreaking, setCcBreaking] = useState(false);
  useEffect(() => {
    api.commitHelpers(root).then(
      (h) => {
        setHelpers(h);
        // A configured commit.template fills an empty message.
        if (h.template && !drafts.get(root)?.summary && !drafts.get(root)?.body) {
          const lines = h.template.replace(/^#.*$/gm, "").split("\n");
          setSummary((cur) => cur || lines[0].trim());
          setBody((cur) => cur || lines.slice(1).join("\n").trim());
        }
      },
      () => {},
    );
  }, [root]);
  useEffect(() => {
    api.signingGet(root).then((c) => setSign(c.signCommits), () => {});
  }, [root]);
  const [busy, setBusy] = useState(false);
  const conflicts = tab.status?.conflictCount ?? 0;
  const layers = tab.layers?.active ? tab.layers.layers : [];

  useEffect(() => {
    drafts.set(root, { summary, body });
  }, [root, summary, body]);

  // Prefill the message for merges / cherry-picks; drop it again once the operation ends.
  useEffect(() => {
    const pre = prefilledMessages.get(root);
    if ((kind === "merge" || kind === "squash" || kind === "cherry-pick" || kind === "revert") && state?.message && !summary) {
      const clean = state.message.replace(/^#.*$/gm, "").trim();
      const [s, ...rest] = clean.split("\n");
      const next = { summary: s ?? "", body: rest.join("\n").trim() };
      prefilledMessages.set(root, next);
      setSummary(next.summary);
      setBody(next.body);
    } else if (kind === "none" && pre) {
      if (summary === pre.summary && body === pre.body) {
        setSummary("");
        setBody("");
      }
      prefilledMessages.delete(root);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, state?.message]);

  const toggleAmend = async (v: boolean) => {
    setAmend(v);
    if (v && !summary.trim()) {
      const last = await api.lastMessage(root).catch(() => "");
      const [s, ...rest] = last.split("\n");
      setSummary(s ?? "");
      setBody(rest.join("\n").trim());
    }
  };

  const message = body.trim() ? `${summary.trim()}\n\n${body.trim()}` : summary.trim();
  const merging = kind === "merge" || kind === "squash";
  const picking = kind === "cherry-pick" || kind === "revert";
  const rebasing = kind === "rebase";
  const canCommit = !busy && !!summary.trim() && conflicts === 0 && (stagedCount > 0 || amend || merging);

  const reset = () => {
    setSummary("");
    setBody("");
    setAmend(false);
    drafts.delete(root);
  };

  const doCommit = async (push = false) => {
    if (!canCommit && !(picking || rebasing)) return;
    setBusy(true);
    try {
      if (merging) {
        const out = await A.act(root, () => api.opContinue(root, kind, message), { busy: "Committing merge" });
        if (out) {
          toast.success(kind === "merge" ? "Merge committed" : "Squash committed");
          reset();
          if (push) await A.quickPush(root);
        }
      } else if (picking) {
        await A.act(root, () => api.opContinue(root, kind, message || null), { success: "Continued" });
        reset();
      } else {
        const ok = await commitChecked(push, noVerify);
        if (ok) reset();
      }
    } finally {
      setBusy(false);
    }
  };

  /** Commit with the large-file check and readable hook failures. */
  const commitChecked = async (push: boolean, skipHooks: boolean): Promise<boolean> => {
    const finalMessage = conventional && ccType ? `${ccType}${ccScope.trim() ? `(${ccScope.trim()})` : ""}${ccBreaking ? "!" : ""}: ${message}` : message;
    if (!amend) {
      const limit = useSettings.getState().largeFileMb * 1024 * 1024;
      const big = await api.largeStagedFiles(root, limit).catch(() => []);
      if (big.length) {
        const choice = await largeFilesDialog(big);
        if (choice === "cancel") return false;
        if (choice === "lfs") {
          const patterns = [...new Set(big.map((f) => (f.path.includes(".") ? `*.${f.path.split(".").pop()}` : f.path)))];
          try {
            for (const pt of patterns) await api.lfsTrack(root, pt, true);
            await api.stage(root, [...big.map((f) => f.path), ".gitattributes"]);
            toast.success("Moved to Git LFS", patterns.join(", "));
          } catch (e) {
            toast.error(e, "Could not set up Git LFS");
            return false;
          }
        }
      }
    }
    try {
      const oid = await api.commit(root, finalMessage, { amend, signOff, noVerify: skipHooks, sign });
      toast.success(`Committed ${oid.slice(0, 8)}`);
      await useRepos.getState().refresh(root);
      if (push) await A.quickPush(root);
      return true;
    } catch (e) {
      await useRepos.getState().refresh(root);
      if (isGitError(e) && e.kind === "identity") {
        if (await identityDialog(root)) return commitChecked(push, skipHooks);
        return false;
      }
      if (!skipHooks && helpers?.hooks.some((h) => h === "pre-commit" || h === "commit-msg" || h === "prepare-commit-msg")) {
        const choice = await hookFailedDialog(e, helpers.hooks);
        if (choice === "retry") return commitChecked(push, false);
        if (choice === "skip") return commitChecked(push, true);
        return false;
      }
      toast.error(e, "Commit failed");
      return false;
    }
  };

  const label = merging ? (kind === "merge" ? "Confirm merge" : "Commit squash") : picking ? `Continue ${kind}` : amend ? "Amend commit" : stagedCount ? `Commit ${plural(stagedCount, "file")}` : "Commit";

  if (rebasing) {
    return (
      <div className="commit-box">
        <div className="callout">
          <Info size={15} />
          <div>Rebase in progress. Stage your edits, then use the banner above to amend and continue.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="commit-box">
      {conventional && !merging && !picking && (
        <div className="hstack" style={{ gap: 6 }}>
          <select className="select" style={{ width: 110 }} value={ccType} onChange={(e) => setCcType(e.target.value)} title="Conventional commit type">
            {["feat", "fix", "docs", "refactor", "perf", "test", "build", "ci", "chore", "style", "revert"].map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          <input className="input" style={{ flex: 1 }} placeholder="scope (optional)" value={ccScope} onChange={(e) => setCcScope(e.target.value)} />
          <label className="check" title="Breaking change (adds !)">
            <input type="checkbox" checked={ccBreaking} onChange={(e) => setCcBreaking(e.target.checked)} /> !
          </label>
        </div>
      )}
      <datalist id={`recent-${root.length}`}>
        {(helpers?.recent ?? []).slice(0, 50).map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
      <div className="summary-wrap">
        <input
          className="input"
          list={`recent-${root.length}`}
          autoComplete="off"
          placeholder={merging ? "Merge commit message" : conventional ? "short description" : "Summary (required)"}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) doCommit();
          }}
          style={{ paddingRight: 40, fontWeight: 500 }}
        />
        <span className={`counter ${summary.length > 72 ? "over" : ""}`}>{summary.length || ""}</span>
      </div>
      <textarea
        className="textarea"
        rows={3}
        placeholder="Description"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) doCommit();
        }}
      />
      {!merging && !picking && (
        <div className="commit-opts">
          <label className="check">
            <input type="checkbox" checked={amend} onChange={(e) => toggleAmend(e.target.checked)} /> Amend
          </label>
          <label className="check">
            <input type="checkbox" checked={signOff} onChange={(e) => setSignOff(e.target.checked)} /> Sign-off
          </label>
          <label className="check" title="Sign the commit with your GPG / SSH key (configure in Settings)">
            <input type="checkbox" checked={sign} onChange={(e) => setSign(e.target.checked)} /> Sign
          </label>
          <label className="check" title="Prefix messages with feat:, fix:, docs: … (Conventional Commits)">
            <input type="checkbox" checked={conventional} onChange={(e) => useSettings.getState().set({ conventionalCommits: e.target.checked })} /> Conventional
          </label>
          <label className="check" title={helpers?.hooks.length ? `Hooks: ${helpers.hooks.join(", ")}` : "Skip pre-commit and commit-msg hooks"}>
            <input type="checkbox" checked={noVerify} onChange={(e) => setNoVerify(e.target.checked)} /> Skip hooks
          </label>
        </div>
      )}
      {conflicts > 0 && (
        <div className="callout danger">
          <Swords size={15} />
          <div>Resolve {plural(conflicts, "conflict")} before committing.</div>
        </div>
      )}
      <div className="split-btn">
        <button className="btn primary" disabled={!canCommit && !picking} onClick={() => doCommit()} title="Ctrl+Enter">
          {merging ? <GitMerge size={15} /> : <Check size={15} />} {label}
        </button>
        <button
          className="btn primary"
          disabled={!canCommit}
          onClick={(e) =>
            contextMenu(e, [
              { label: `${label} & push`, icon: <CloudUpload size={14} />, onClick: () => doCommit(true) },
              ...layers.map((l) => ({
                label: `Commit only ${l.name}…`,
                icon: <Layers size={14} />,
                onClick: () => commitLayer(root, l, false),
              })),
            ])
          }
        >
          <ChevronDown size={14} />
        </button>
      </div>
    </div>
  );
}

function largeFilesDialog(files: LargeFile[]): Promise<"lfs" | "commit" | "cancel"> {
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  return showDialog((close) => (
    <Modal
      title="Large files staged"
      subtitle="Big binaries bloat the repository forever. Git LFS stores them outside the history."
      icon={<HardDrive size={18} />}
      tone="warn"
      onClose={() => close("cancel")}
      footer={
        <>
          <button type="button" className="btn" onClick={() => close("cancel")}>
            Cancel
          </button>
          <button type="button" className="btn" onClick={() => close("commit")}>
            Commit anyway
          </button>
          <button type="button" className="btn primary" onClick={() => close("lfs")}>
            Track with Git LFS
          </button>
        </>
      }
    >
      <div className="code-list">{files.map((f) => `${mb(f.size).padStart(9)}  ${f.path}`).join("\n")}</div>
    </Modal>
  ));
}

function hookFailedDialog(e: unknown, hooks: string[]): Promise<"retry" | "skip" | "close"> {
  const err = e as Partial<GitError>;
  const output = (err.stderr || err.message || String(e)).trim();
  return showDialog((close) => (
    <Modal
      title="A commit hook stopped the commit"
      subtitle={`Hooks in this repository: ${hooks.join(", ")}`}
      icon={<Info size={18} />}
      tone="danger"
      wide
      onClose={() => close("close")}
      footer={
        <>
          <button type="button" className="btn" onClick={() => close("close")}>
            Close
          </button>
          <button type="button" className="btn" onClick={() => close("skip")}>
            Commit without hooks
          </button>
          <button type="button" className="btn primary" onClick={() => close("retry")}>
            Retry
          </button>
        </>
      }
    >
      <div className="code-list" style={{ maxHeight: 340 }}>
        {output || "The hook exited with an error but printed nothing."}
      </div>
    </Modal>
  ));
}
