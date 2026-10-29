import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, Loader2, RotateCcw, Save, Swords, X, FileQuestion, Trash2, ArrowUp, ArrowDown } from "lucide-react";
import { Compartment, EditorState, RangeSetBuilder, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, type DecorationSet } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { syntaxHighlighting, bracketMatching, indentOnInput } from "@codemirror/language";
import { classHighlighter } from "@lezer/highlight";
import { api, errorMessage } from "../lib/api";
import { useRepos } from "../lib/store";
import { toast } from "../lib/ui";
import type { ConflictInfo } from "../lib/types";
import { findLines, parseConflicts, resolveBlock, type ConflictBlock, type Resolution } from "../lib/conflicts";
import { languageFor } from "../lib/languages";
import { conflictLabel } from "../lib/format";
import { confirmDialog } from "./dialogs";
import { useSettings } from "../lib/settings";
import { Splitter } from "./Overlays";
import { conflictDraftKey, conflictDrafts, conflictInitialText, conflictOutput, normalizeConflictText, sameConflictVersions } from "../lib/conflictStudio";
import { ConflictValidation } from "./ConflictValidation";
import { useValidation, validationRunning } from "../lib/validation";
import "../styles/conflictStudio.css";

interface Labels {
  ours: string;
  theirs: string;
}

class ActionsWidget extends WidgetType {
  constructor(
    readonly index: number,
    readonly labels: Labels,
    readonly hasBase: boolean,
  ) {
    super();
  }
  eq(o: ActionsWidget) {
    return o.index === this.index && o.labels.ours === this.labels.ours && o.labels.theirs === this.labels.theirs && o.hasBase === this.hasBase;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cf-actions";
    const lbl = document.createElement("span");
    lbl.className = "lbl";
    lbl.textContent = `Conflict ${this.index + 1}`;
    wrap.appendChild(lbl);
    const add = (text: string, how: Resolution, cls = "") => {
      const b = document.createElement("button");
      b.textContent = text;
      b.className = cls;
      b.onmousedown = (e) => {
        e.preventDefault();
        applyAt(view, this.index, how);
      };
      wrap.appendChild(b);
    };
    add(`Accept ours · ${this.labels.ours}`, "ours", "ours");
    add(`Accept theirs · ${this.labels.theirs}`, "theirs", "theirs");
    add("Both", "both");
    add("Both (theirs first)", "both-theirs-first");
    if (this.hasBase) add("Base", "base");
    add("None", "none");
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}

function applyAt(view: EditorView, index: number, how: Resolution) {
  if (view.state.readOnly) return;
  const text = view.state.doc.toString();
  const blocks = parseConflicts(text);
  const b = blocks[index];
  if (!b) return;
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const insert = resolveBlock(b, how, eol, text.slice(b.from, b.to).endsWith("\n"));
  view.dispatch({ changes: { from: b.from, to: b.to, insert }, selection: { anchor: b.from }, scrollIntoView: true, userEvent: "input.resolve" });
  view.focus();
}

function conflictField(labels: Labels): Extension {
  const build = (state: EditorState): DecorationSet => {
    const text = state.doc.toString();
    const blocks = parseConflicts(text);
    const builder = new RangeSetBuilder<Decoration>();
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const startLine = state.doc.lineAt(b.from);
      builder.add(startLine.from, startLine.from, Decoration.widget({ widget: new ActionsWidget(i, labels, b.base !== null), side: -1, block: true }));
      let section: "ours" | "base" | "theirs" = "ours";
      for (let ln = b.startLine + 1; ln <= b.endLine + 1; ln++) {
        const line = state.doc.line(ln);
        const t = line.text.replace(/\r$/, "");
        let cls: string;
        if (ln === b.startLine + 1 || ln === b.endLine + 1) cls = "cm-cf-marker";
        else if (t.startsWith("|||||||") && section === "ours") {
          section = "base";
          cls = "cm-cf-marker";
        } else if (/^={7,}$/.test(t) && section !== "theirs") {
          section = "theirs";
          cls = "cm-cf-marker";
        } else cls = section === "ours" ? "cm-cf-ours" : section === "base" ? "cm-cf-base" : "cm-cf-theirs";
        builder.add(line.from, line.from, Decoration.line({ class: cls }));
      }
    }
    return builder.finish();
  };
  return StateField.define<DecorationSet>({
    create: build,
    update: (deco, tr) => (tr.docChanged ? build(tr.state) : deco),
    provide: (f) => EditorView.decorations.from(f),
  });
}

function sideHighlights(text: string, ranges: [number, number][], cls: string): Extension {
  const state = EditorState.create({ doc: text });
  const builder = new RangeSetBuilder<Decoration>();
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  for (const [start, count] of sorted) {
    for (let k = 0; k < count; k++) {
      const ln = start + k + 1;
      if (ln > state.doc.lines) break;
      const line = state.doc.line(ln);
      builder.add(line.from, line.from, Decoration.line({ class: cls }));
    }
  }
  return EditorView.decorations.of(builder.finish());
}

function useEditor(host: React.RefObject<HTMLDivElement | null>, doc: string | null, extensions: Extension[], deps: unknown[]) {
  const viewRef = useRef<EditorView | null>(null);
  useEffect(() => {
    if (!host.current || doc === null) return;
    const view = new EditorView({ state: EditorState.create({ doc, extensions }), parent: host.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return viewRef;
}

const baseExtensions = (): Extension[] => [
  lineNumbers(),
  highlightActiveLineGutter(),
  drawSelection(),
  syntaxHighlighting(classHighlighter),
  bracketMatching(),
  highlightSelectionMatches(),
  EditorView.theme({ "&": { height: "100%" } }),
];

/** Finds where each conflict's sides live in the full ours / theirs files. */
function locate(blocks: ConflictBlock[], ours: string, theirs: string, base = "") {
  const oLines = ours.split("\n");
  const tLines = theirs.split("\n");
  const bLines = base.split("\n");
  let bFrom = 0;
  let oFrom = 0;
  let tFrom = 0;
  return blocks.map((b) => {
    const o = findLines(oLines, b.ours, oFrom);
    const t = findLines(tLines, b.theirs, tFrom);
    const ancestor = b.base ? findLines(bLines, b.base, bFrom) : -1;
    if (ancestor >= 0) bFrom = ancestor + b.base!.length;
    if (o >= 0) oFrom = o + b.ours.length;
    if (t >= 0) tFrom = t + b.theirs.length;
    return { ours: o >= 0 ? ([o, b.ours.length] as [number, number]) : null, theirs: t >= 0 ? ([t, b.theirs.length] as [number, number]) : null, base: ancestor >= 0 ? ([ancestor, b.base!.length] as [number, number]) : null };
  });
}

/** Loads a conflicted file of the working tree into the merge editor. */
export function ConflictEditor({ root, path, onClose }: { root: string; path: string; onClose: () => void }) {
  const draftKey = conflictDraftKey(root, path);
  const cached = useRef(conflictDrafts.get(draftKey));
  const observedState = useRef<string | null>(null);
  const [info, setInfo] = useState<ConflictInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [showValidation, setShowValidation] = useState(false);
  const [revision, setRevision] = useState(0);
  const [changedOnDisk, setChangedOnDisk] = useState(false);
  const validation = useValidation((s) => s.reports[root]);
  const statusFiles = useRepos((s) => s.tabs[root]?.status?.files);
  const conflicts = useMemo(() => (statusFiles ?? []).filter((f) => f.conflict).map((f) => f.path), [statusFiles]);

  useEffect(() => {
    let alive = true;
    observedState.current = useRepos.getState().tabs[root]?.status?.stateToken ?? null;
    setInfo(null);
    setErr(null);
    const old = conflictDrafts.get(draftKey);
    if (old) {
      observedState.current = old.token; setInfo(old.info);
      void api.conflictInfo(root, path).then((fresh) => {
        if (!alive) return;
        if (sameConflictVersions(old.info, fresh)) { observedState.current = fresh.stateToken ?? null; old.token = observedState.current; old.info = fresh; }
        else setChangedOnDisk(true);
      }, () => { if (alive) setChangedOnDisk(true); });
      return () => { alive = false; };
    }
    api.conflictInfo(root, path).then(
      (i) => { if (alive) { observedState.current = i.stateToken ?? null; setInfo(i); } },
      (e) => alive && setErr(errorMessage(e)),
    );
    return () => {
      alive = false;
    };
  }, [root, path, draftKey]);

  const navigate = (next: string) => useRepos.getState().patch(root, { conflictPath: next, changeSel: { kind: "conflict", path: next } });

  const nextFile = async () => {
    await useRepos.getState().refresh(root, { status: true, layers: true, info: true });
    const left = useRepos.getState().tabs[root]?.status?.files.filter((f) => f.conflict && f.path !== path) ?? [];
    if (left.length) {
      useRepos.getState().patch(root, { conflictPath: left[0].path, changeSel: { kind: "conflict", path: left[0].path } });
    } else {
      toast.success("All conflicts resolved", "Review the result and confirm to finish.");
      onClose();
    }
  };

  const fileIdx = conflicts.indexOf(path);
  return (
    <MergeEditor
      key={revision}
      path={path}
      info={info}
      error={err}
      position={conflicts.length > 1 && fileIdx >= 0 ? `file ${fileIdx + 1} of ${conflicts.length}` : undefined}
      files={conflicts}
      onNavigate={navigate}
      initialText={cached.current?.text}
      onDirtyChange={setDirty}
      onDraft={(text) => { if (info) conflictDrafts.set(draftKey, { info: conflictDrafts.get(draftKey)?.info ?? info, text, token: observedState.current }); }}
      blocked={validationRunning(validation)}
      tools={<>
        {changedOnDisk && <span className="pill red">File changed on disk · review current versions</span>}
        <button className="btn sm" onClick={() => setShowValidation((v) => !v)}>Validate</button>
        <button className="btn sm ghost" disabled={validationRunning(validation)} title="Load current Git versions while retaining this draft for review" onClick={async () => {
          try {
            const fresh = await api.conflictInfo(root, path);
            const draft = conflictDrafts.get(draftKey);
            if (draft && draft.text !== conflictInitialText(fresh) && !await confirmDialog({
              title: "Use this draft with the current versions?",
              message: "The disk result differs from the editor draft. Keeping the draft may replace external edits when you save. Review both texts below; cancel to keep the old state guard.",
              details: ["Current working file (first 8000 characters):", (fresh.working ?? fresh.merged).slice(0, 8000), "Editor draft (first 8000 characters):", draft.text.slice(0, 8000)],
              confirm: "Keep draft", danger: true,
            })) return;
            observedState.current = fresh.stateToken ?? null;
            if (draft) { draft.info = fresh; draft.token = observedState.current; cached.current = draft; }
            setInfo(fresh); setErr(null); setChangedOnDisk(false); setRevision((v) => v + 1);
          } catch (e) { toast.error(e); }
        }}>Review current versions</button>
      </>}
      footer={showValidation && <ConflictValidation root={root} dirty={dirty} onClose={() => setShowValidation(false)} />}
      onClose={onClose}
      onSaveDraft={async (text) => {
        await api.conflictSave(root, path, text, false, observedState.current);
        const fresh = await api.conflictInfo(root, path);
        observedState.current = fresh.stateToken ?? null;
        conflictDrafts.set(draftKey, { info: fresh, text: normalizeConflictText(text), token: observedState.current });
        toast.success(`Saved draft: ${path}`, "The file remains unresolved.");
      }}
      onSave={async (text) => {
        await api.conflictSave(root, path, text, true, observedState.current);
        conflictDrafts.delete(draftKey);
        toast.success(`Resolved ${path}`);
        await nextFile();
      }}
      onTake={async (which) => {
        await api.conflictTake(root, path, which, observedState.current);
        conflictDrafts.delete(draftKey);
        toast.success(which === "delete" ? `Deleted ${path}` : `Took ${which} for ${path}`);
        await nextFile();
      }}
    />
  );
}

export interface MergeEditorProps {
  path: string;
  /** null while loading. */
  info: ConflictInfo | null;
  error?: string | null;
  /** e.g. "file 2 of 3". */
  position?: string;
  files?: string[];
  onNavigate?: (path: string) => void;
  initialText?: string;
  onDraft?: (text: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onSaveDraft?: (text: string) => Promise<void>;
  blocked?: boolean;
  tools?: ReactNode;
  footer?: ReactNode;
  saveLabel?: string;
  onSave: (text: string) => Promise<void>;
  onTake: (which: "ours" | "theirs" | "delete") => Promise<void>;
  onClose: () => void;
}

/** Three-pane merge editor (ours / theirs / editable result) for any set of three versions. */
export function MergeEditor({ path, info, error: err, position, saveLabel = "Save & mark resolved", onSave, onTake, onClose, files, onNavigate, initialText, onDraft, onDirtyChange, onSaveDraft, blocked = false, tools, footer }: MergeEditorProps) {
  const [lang, setLang] = useState<Extension | null>(null);
  const [langReady, setLangReady] = useState(false);
  const [remaining, setRemaining] = useState(0);
  const [current, setCurrent] = useState(0);
  const [saving, setSaving] = useState(false);
  const busy = useRef(false);
  const locked = useRef(false);
  locked.current = saving || blocked;
  const [dirty, setDirty] = useState(false);
  const baseline = useRef("");
  const draftRef = useRef(onDraft); draftRef.current = onDraft;
  const dirtyRef = useRef(onDirtyChange); dirtyRef.current = onDirtyChange;
  const editability = useMemo(() => new Compartment(), []);
  const [topH, setTopH] = useState(0.4);
  const bodyRef = useRef<HTMLDivElement>(null);
  const oursHost = useRef<HTMLDivElement>(null);
  const theirsHost = useRef<HTMLDivElement>(null);
  const baseHost = useRef<HTMLDivElement>(null);
  const resultHost = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setLangReady(false);
    languageFor(path).then((l) => {
      if (!alive) return;
      setLang(l ?? null);
      setLangReady(true);
    });
    return () => {
      alive = false;
    };
  }, [path]);

  const textual = !!info && info.ours.exists && info.theirs.exists && !info.ours.binary && !info.theirs.binary && !info.base.binary;
  const initial = useMemo(() => {
    if (!info || !textual) return null;
    return initialText ?? conflictInitialText(info);
  }, [info, textual, initialText]);

  const located = useMemo(() => (info && textual ? locate(parseConflicts(info.merged), info.ours.text, info.theirs.text, info.base.text) : []), [info, textual]);
  const showBase = useSettings((s) => s.mergeShowBase);
  const labels: Labels = { ours: info?.oursLabel ?? "ours", theirs: info?.theirsLabel ?? "theirs" };
  const ready = !!info && textual && langReady;

  const oursView = useEditor(
    oursHost,
    ready ? info!.ours.text : null,
    [...baseExtensions(), EditorState.readOnly.of(true), EditorView.editable.of(false), ...(lang ? [lang] : []), sideHighlights(info?.ours.text ?? "", located.flatMap((l) => (l.ours ? [l.ours] : [])), "cm-side-hl-ours")],
    [ready, info],
  );
  const theirsView = useEditor(
    theirsHost,
    ready ? info!.theirs.text : null,
    [...baseExtensions(), EditorState.readOnly.of(true), EditorView.editable.of(false), ...(lang ? [lang] : []), sideHighlights(info?.theirs.text ?? "", located.flatMap((l) => (l.theirs ? [l.theirs] : [])), "cm-side-hl-theirs")],
    [ready, info],
  );
  const baseView = useEditor(baseHost, ready && showBase ? info!.base.text : null,
    [...baseExtensions(), EditorState.readOnly.of(true), EditorView.editable.of(false), ...(lang ? [lang] : []), sideHighlights(info?.base.text ?? "", located.flatMap((l) => l.base ? [l.base] : []), "cm-cf-base")], [ready, info, showBase]);

  const goto = useCallback(
    (i: number) => {
      const view = resultView.current;
      if (!view) return;
      const blocks = parseConflicts(view.state.doc.toString());
      if (!blocks.length) return;
      const idx = ((i % blocks.length) + blocks.length) % blocks.length;
      setCurrent(idx);
      const b = blocks[idx];
      view.dispatch({ selection: { anchor: b.from }, effects: EditorView.scrollIntoView(b.from, { y: "center" }) });
      view.focus();
      // Align side panes on the matching region when we know it.
      // Match the remaining block against the original list, whose indexes do
      // not shift when an earlier conflict is resolved.
      const original = parseConflicts(info?.merged ?? "");
      const candidates = original.map((block, index) => ({ block, index })).filter(({ block }) => block.ours.join("\n") === b.ours.join("\n") && block.theirs.join("\n") === b.theirs.join("\n"));
      const loc = candidates.length === 1 ? located[candidates[0].index] : undefined;
      const scrollSide = (v: EditorView | null, line: number | undefined) => {
        if (!v || line === undefined) return;
        const l = v.state.doc.line(Math.min(v.state.doc.lines, line + 1));
        v.dispatch({ effects: EditorView.scrollIntoView(l.from, { y: "center" }) });
      };
      scrollSide(oursView.current, loc?.ours?.[0]);
      scrollSide(theirsView.current, loc?.theirs?.[0]);
      scrollSide(baseView.current, loc?.base?.[0]);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [located, info],
  );

  const resultView = useEditor(
    resultHost,
    ready ? initial : null,
    [
      ...baseExtensions(),
      highlightActiveLine(),
      history(),
      editability.of([EditorState.readOnly.of(locked.current), EditorView.editable.of(!locked.current)]),
      indentOnInput(),
      keymap.of([
        { key: "Alt-ArrowDown", run: () => (gotoRef.current(currentRef.current + 1), true) },
        { key: "Alt-ArrowUp", run: () => (gotoRef.current(currentRef.current - 1), true) },
        { key: "Mod-s", run: () => (saveRef.current(), true) },
        indentWithTab,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
      ]),
      ...(lang ? [lang] : []),
      conflictField(labels),
      EditorView.updateListener.of((u) => {
        const text = u.state.doc.toString();
        if (u.docChanged) {
          setRemaining(parseConflicts(text).length);
          const changed = text !== baseline.current;
          setDirty(changed); dirtyRef.current?.(changed); draftRef.current?.(text);
        }
        if (u.docChanged || u.selectionSet) {
          const blocks = parseConflicts(text);
          const at = blocks.findIndex((b) => b.to > u.state.selection.main.head);
          setCurrent(at < 0 ? Math.max(0, blocks.length - 1) : at);
        }
      }),
    ],
    [ready, initial],
  );
  useEffect(() => {
    resultView.current?.dispatch({ effects: editability.reconfigure([EditorState.readOnly.of(saving || blocked), EditorView.editable.of(!saving && !blocked)]) });
  }, [saving, blocked, editability, resultView, ready]);

  // Keep the side panes roughly in step with the result pane.
  const syncScroll = useSettings((s) => s.syncScroll);
  useEffect(() => {
    const r = resultView.current?.scrollDOM;
    if (!ready || !r || !syncScroll) return;
    const onScroll = () => {
      const ratio = r.scrollTop / Math.max(1, r.scrollHeight - r.clientHeight);
      for (const v of [oursView.current, theirsView.current, baseView.current]) {
        const d = v?.scrollDOM;
        if (d) d.scrollTop = ratio * (d.scrollHeight - d.clientHeight);
      }
    };
    r.addEventListener("scroll", onScroll, { passive: true });
    return () => r.removeEventListener("scroll", onScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, initial, syncScroll, showBase]);

  const currentRef = useRef(0);
  currentRef.current = current;
  const gotoRef = useRef(goto);
  gotoRef.current = goto;

  useEffect(() => {
    if (!ready || initial === null) return;
    setRemaining(parseConflicts(initial).length);
    baseline.current = info ? conflictInitialText(info) : initial;
    setDirty(initial !== baseline.current); dirtyRef.current?.(initial !== baseline.current);
    const t = setTimeout(() => goto(0), 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, initial]);

  const save = async (draft = false) => {
    const view = resultView.current;
    if (!view || busy.current || locked.current) return;
    busy.current = true; setSaving(true);
    // Freeze synchronously before any confirmation or backend await.
    view.dispatch({ effects: editability.reconfigure([EditorState.readOnly.of(true), EditorView.editable.of(false)]) });
    const text = view.state.doc.toString();
    const left = parseConflicts(text).length;
    try {
    if (!draft && left > 0) {
      const ok = await confirmDialog({ title: "Conflict markers remain", message: `${left} conflict(s) are still unresolved in the result. Save and mark the file resolved anyway?`, confirm: "Save anyway", danger: true });
      if (!ok) return;
    }
      const output = info ? conflictOutput(text, info) : text;
      if (draft && onSaveDraft) {
        await onSaveDraft(output);
        baseline.current = text; setDirty(false); dirtyRef.current?.(false);
      } else await onSave(output);
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
      busy.current = false;
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  const take = async (which: "ours" | "theirs" | "delete") => {
    if (busy.current || locked.current) return;
    busy.current = true; setSaving(true);
    try {
      if (dirty && !await confirmDialog({ title: "Replace manual edits?", message: "Taking a whole file replaces this editor draft. The working file is saved in a recovery checkpoint first.", confirm: "Replace draft", danger: true })) return;
      await onTake(which);
    } catch (e) {
      toast.error(e);
    } finally { busy.current = false; setSaving(false); }
  };

  const resetResult = async () => {
    const view = resultView.current;
    if (!view || !info || locked.current) return;
    if (!await confirmDialog({ title: "Reset the result?", message: "Replace this editor draft with the generated merge? You can undo the reset with Ctrl+Z.", confirm: "Reset result", danger: true })) return;
    if (locked.current) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: normalizeConflictText(info.merged) } });
    setTimeout(() => goto(0), 0);
  };

  const resolveAllWith = (how: Resolution) => {
    const view = resultView.current;
    if (!view || locked.current) return;
    const text = view.state.doc.toString();
    const blocks = parseConflicts(text).reverse();
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    view.dispatch({
      changes: blocks.map((b) => ({ from: b.from, to: b.to, insert: resolveBlock(b, how, eol, text.slice(b.from, b.to).endsWith("\n")) })),
      userEvent: "input.resolve",
    });
  };

  return (
    <div className="conflict-overlay" onKeyDown={(e) => {
      if (!e.altKey || !onNavigate || !files?.length || locked.current) return;
      if (e.key !== "PageDown" && e.key !== "PageUp") return;
      e.preventDefault();
      const index = files.indexOf(path);
      onNavigate(files[(index + (e.key === "PageDown" ? 1 : files.length - 1)) % files.length]);
    }}>
      <div className="cf-head">
        <Swords size={18} style={{ color: "var(--red)" }} />
        <div className="cf-title">
          <span className="p">{path}</span>
          <span className="s">
            {info ? conflictLabel(info.code) : "Loading…"}
            {position ? ` · ${position}` : ""}
          </span>
        </div>
        {onNavigate && files && files.length > 0 && <div className="cf-file-nav" aria-label="Conflicted files">
          <button className="icon-btn sm" title="Previous file (Alt+PageUp)" disabled={saving || blocked || files.length < 2} onClick={() => onNavigate(files[(files.indexOf(path) + files.length - 1) % files.length])}><ChevronUp size={14} /></button>
          <select className="input" aria-label="Conflict file" value={path} disabled={saving || blocked} onChange={(e) => onNavigate(e.target.value)}>{!files.includes(path) && <option value={path}>{path}</option>}{files.map((file) => <option key={file} value={file}>{file}</option>)}</select>
          <button className="icon-btn sm" title="Next file (Alt+PageDown)" disabled={saving || blocked || files.length < 2} onClick={() => onNavigate(files[(files.indexOf(path) + 1) % files.length])}><ChevronDown size={14} /></button>
        </div>}
        {textual && (
          <div className="cf-nav">
            <button className="icon-btn sm" onClick={() => goto(current - 1)} title="Previous conflict (Alt+↑)">
              <ChevronUp size={15} />
            </button>
            <span className="cnt">{remaining ? `${Math.min(current + 1, remaining)} of ${remaining} left` : "All resolved"}</span>
            <button className="icon-btn sm" onClick={() => goto(current + 1)} title="Next conflict (Alt+↓)">
              <ChevronDown size={15} />
            </button>
          </div>
        )}
        <div className="spacer" />
        {tools}
        {textual && (
          <>
            <button className="btn sm" onClick={() => resolveAllWith("ours")} title="Resolve every remaining conflict with our side">
              All ours
            </button>
            <button className="btn sm" onClick={() => resolveAllWith("theirs")} title="Resolve every remaining conflict with their side">
              All theirs
            </button>
            <label className="check" title="Scroll the ours / theirs panes together with the result">
              <input type="checkbox" checked={syncScroll} onChange={(e) => useSettings.getState().set({ syncScroll: e.target.checked })} /> Sync scroll
            </label>
            <label className="check"><input type="checkbox" checked={showBase} onChange={(e) => useSettings.getState().set({ mergeShowBase: e.target.checked })} /> Base</label>
            <button className="btn sm ghost" onClick={resetResult} title="Start over" disabled={saving || blocked}>
              <RotateCcw size={13} /> Reset
            </button>
          </>
        )}
        <button className="btn" onClick={async () => {
          if (dirty && !onDraft && !await confirmDialog({ title: "Close unsaved result?", message: "This result has unsaved changes.", confirm: "Close without saving", danger: true })) return;
          onClose();
        }} disabled={saving} title={onDraft ? "Drafts are kept in this session; Save draft writes them to disk" : "Close editor"}>
          <X size={14} /> Close
        </button>
        {textual && (
          <button className={`btn ${remaining ? "" : "primary"}`} onClick={() => save()} disabled={saving || blocked} title="Ctrl+S">
            {saving ? <Loader2 size={14} className="spin" /> : <Save size={14} />} {saveLabel}
          </button>
        )}
        {textual && onSaveDraft && <button className="btn" disabled={saving || blocked || !dirty} onClick={() => save(true)}>Save draft</button>}
        {dirty && <span className="cf-draft-note">{onDraft ? "Unsaved · kept during navigation in this session" : "Unsaved changes"}</span>}
      </div>
      {err && <div className="empty">{err}</div>}
      {!err && !info && (
        <div className="loading-center">
          <span className="loader" />
        </div>
      )}
      {info && !textual && (
        <div className="cf-special">
          <div className="cf-special-card">
            <div className="empty" style={{ padding: 0 }}>
              <div className="big" style={{ color: "var(--red)" }}>
                <FileQuestion size={26} />
              </div>
            </div>
            <h3 style={{ margin: 0 }}>{conflictLabel(info.code)}</h3>
            <div className="muted">
              {info.ours.binary || info.theirs.binary
                ? "This is a binary file, so the sides cannot be merged line by line. Pick the version to keep."
                : !info.ours.exists
                  ? `The file was deleted on ${labels.ours} but changed on ${labels.theirs}.`
                  : `The file was changed on ${labels.ours} but deleted on ${labels.theirs}.`}
            </div>
            <div className="hstack" style={{ flexWrap: "wrap", justifyContent: "center" }}>
              {info.ours.exists && (
                <button className="btn lg" onClick={() => take("ours")}>
                  <ArrowUp size={15} /> Keep ours ({labels.ours})
                </button>
              )}
              {info.theirs.exists && (
                <button className="btn lg" onClick={() => take("theirs")}>
                  <ArrowDown size={15} /> Take theirs ({labels.theirs})
                </button>
              )}
              <button className="btn lg danger" onClick={() => take("delete")}>
                <Trash2 size={15} /> Delete file
              </button>
            </div>
          </div>
        </div>
      )}
      {textual && (
        <div className="cf-body" ref={bodyRef} style={{ gridTemplateRows: `minmax(100px, ${topH * 100}%) 7px minmax(140px, 1fr)` }}>
          <div className={`cf-sides ${showBase ? "with-base" : ""}`}>
            <div className="cf-pane">
              <div className="cf-pane-head">
                <span className="dot" style={{ background: "var(--blue)" }} />
                <span className="lbl">Ours</span>
                <span className="sub">{labels.ours} — current</span>
                <div className="spacer" />
                <button className="btn sm" onClick={() => take("ours")} title="Use our whole file">
                  Take file
                </button>
              </div>
              <div className="cf-editor" ref={oursHost} />
            </div>
            {showBase && <div className="cf-pane cf-base">
              <div className="cf-pane-head"><span className="lbl">Base</span><span className="sub">{info?.base.exists ? "common ancestor · read only" : "No common ancestor (added on both sides)"}</span></div>
              <div className="cf-editor" ref={baseHost} />
            </div>}
            <div className="cf-pane">
              <div className="cf-pane-head">
                <span className="dot" style={{ background: "var(--pink)" }} />
                <span className="lbl">Theirs</span>
                <span className="sub">{labels.theirs} — incoming</span>
                <div className="spacer" />
                <button className="btn sm" onClick={() => take("theirs")} title="Use their whole file">
                  Take file
                </button>
              </div>
              <div className="cf-editor" ref={theirsHost} />
            </div>
          </div>
          <Splitter
            dir="h"
            onDrag={(d) => {
              const h = bodyRef.current?.clientHeight ?? 600;
              setTopH((t) => Math.max(0.15, Math.min(0.75, t + d / h)));
            }}
          />
          <div className="cf-result">
            <div className="cf-pane-head">
              <span className="dot" style={{ background: "var(--accent)" }} />
              <span className="lbl">Result</span>
              <span className="sub">editable — use the buttons above each conflict, or type freely</span>
              <div className="spacer" />
              {remaining > 0 ? <span className="pill red">{remaining} unresolved</span> : <span className="pill green">no markers left</span>}
            </div>
            <div className="cf-editor" ref={resultHost} />
          </div>
        </div>
      )}
      {footer}
    </div>
  );
}
