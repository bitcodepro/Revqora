import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Compartment, EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, drawSelection, highlightActiveLine, highlightWhitespace, keymap, lineNumbers, type DecorationSet } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo, undoDepth, redoDepth } from "@codemirror/commands";
import { indentUnit, syntaxHighlighting } from "@codemirror/language";
import { classHighlighter } from "@lezer/highlight";
import { api, errorMessage, isGitError } from "../lib/api";
import { editorDocument, tabsToSpaces } from "../lib/textEditing";
import { languageFor } from "../lib/languages";
import { useSettings } from "../lib/settings";
import { matchesShortcut, shortcutTitle } from "../lib/shortcuts";
import { useRepos } from "../lib/store";
import { contextMenu, copyText, useUi } from "../lib/ui";
import { basename } from "../lib/format";
import type { FileDiff } from "../lib/types";
import { confirmDialog } from "./dialogs";
import "../styles/fileEditor.css";

type Snapshot = {content: string; revision: string};
const drafts = new Map<string, {file: Snapshot; text: string}>();
const replaceHighlights = StateEffect.define<DecorationSet>();
const changedLines = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(replaceHighlights)) return effect.value;
    return value.map(tr.changes);
  },
  provide: field => EditorView.decorations.from(field),
});
const workingChange = Decoration.line({ class: "cm-working-change" });

export function WorkingFileEditor({root,path,untracked,displayDiff,close}: {
  root: string; path: string; untracked: boolean; displayDiff: FileDiff | null; close: () => void;
}) {
  const key = JSON.stringify([root, path]);
  const [draft] = useState(() => drafts.get(key));
  const [file,setFile] = useState<Snapshot|null>(draft?.file ?? null);
  const [text,setText] = useState(draft?.text ?? "");
  const [loading,setLoading] = useState(!draft), [saving,setSaving] = useState(false), [error,setError] = useState(""), [epoch,setEpoch] = useState(0);
  const [diff, setDiff] = useState<FileDiff | null>(null);
  const mounted = useRef(true);
  const confirming = useRef(false), [confirmationOpen,setConfirmationOpen] = useState(false);
  const [recovery,setRecovery] = useState<string|null>(null);
  const dirty = !!file && text !== file.content;
  useEffect(() => { mounted.current=true; return () => {mounted.current=false;}; }, []);
  useEffect(() => {
    let alive=true;
    setDiff(null);
    void api.workingDiff(root, path, "unstaged", untracked, { context: 0, disableTextconv: true })
      .then(value => { if (alive) setDiff(value); }).catch(() => {});
    if (!draft || epoch > 0) {
      setLoading(true);setError("");
      api.workingFileRead(root,path).then(value=>{editorDocument(value.content);if(alive){setFile(value);setText(value.content);}}, e=>{if(alive)setError(errorMessage(e));}).catch(e=>{if(alive)setError(errorMessage(e));}).finally(()=>{if(alive)setLoading(false);});
    }
    return()=>{alive=false;};
  },[root,path,untracked,draft,epoch]);
  const changeText = useEffectEvent((next: string) => {
    setText(next);
    if (file && next !== file.content) drafts.set(key, { file, text: next });
    else drafts.delete(key);
  });
  const discard = async () => {
    if(confirming.current)return false;
    if(!dirty)return true;
    confirming.current=true;setConfirmationOpen(true);
    try {return await confirmDialog({title:"Discard editor changes?",message:"Your unsaved draft will be discarded. The file on disk is kept.",confirm:"Discard draft",danger:true});}
    finally {confirming.current=false;if(mounted.current)setConfirmationOpen(false);}
  };
  const onClose = async () => {if(!saving && await discard()){drafts.delete(key);close();}};
  const reload = async () => {if(!saving && await discard()){drafts.delete(key);setFile(null);setLoading(true);setEpoch(e=>e+1);}};
  const save = async () => {
    if(!file||loading||saving||confirming.current||!dirty)return;
    setSaving(true);setError("");setRecovery(null);
    try {
      const result=await api.workingFileSave(root,path,file.revision,text);
      const savedDraft = drafts.get(key);
      if (savedDraft?.file.revision === file.revision && savedDraft.text === text) drafts.delete(key);
      if(!mounted.current)return;
      setFile(result.file);
      useUi.getState().toast({kind:"success",title:"Working file saved",detail:"Staging is unchanged.",action:result.backupPath?{label:"Open original backup",run:()=>{void api.openPath(result.backupPath!);}}:undefined});
      void useRepos.getState().refresh(root,{status:true,layers:true});
    } catch(e) {if(mounted.current){setError(errorMessage(e));if(isGitError(e))setRecovery(e.details.find(v=>v.startsWith("backup-path="))?.slice("backup-path=".length)??null);}}
    finally {if(mounted.current)setSaving(false);}
  };
  return <section className="working-file-editor" aria-label="Edit working file" onKeyDownCapture={e=>{
    const action = matchesShortcut(e, "workingFileSave") ? save : matchesShortcut(e, "workingFileClose") ? onClose : matchesShortcut(e, "workingFileReload") ? reload : null;
    if (action) {e.preventDefault();e.stopPropagation();if(!e.repeat)void action();}
  }}>
    <header className="diff-head">
      <div className="path" title={path} onContextMenu={e => contextMenu(e, [{label:"Copy name", onClick: () => copyText(basename(path), "Name copied")}])}>{path}</div>
      <div className="diff-controls">
        <span className="muted" role="status">{loading?"Loading…":!file?"File not loaded":dirty?"Unsaved changes":"Saved"}</span>
        <button type="button" className="btn sm" disabled={saving||loading} onClick={()=>void reload()}>Reload from disk</button>
        <button type="button" className="btn sm" disabled={saving} onClick={()=>void onClose()}>Close</button>
        <button type="button" className="btn sm primary" disabled={!dirty||loading||saving} onClick={()=>void save()}>{saving?"Saving…":"Save file"}</button>
      </div>
    </header>
    {error&&<div className="callout warn" role="alert">{error}</div>}
    {recovery&&<button type="button" className="btn sm" onClick={()=>void api.openPath(recovery)}>Open recovery copy</button>}
    {loading?<div className="loading-center">Loading working file…</div>:file&&<WorkingCode key={epoch} path={path} initial={text} diff={diff} displayDiff={displayDiff} disabled={saving||confirmationOpen} changed={changeText}/>}
  </section>;
}
function WorkingCode({path,initial,diff,displayDiff,disabled,changed}: {
  path:string; initial:string; diff:FileDiff|null; displayDiff:FileDiff|null; disabled:boolean; changed:(text:string)=>void;
}) {
  const host=useRef<HTMLDivElement>(null),view=useRef<EditorView|null>(null);
  const [size,setSize]=useState(4),[all,setAll]=useState(false);
  const whitespace=useSettings(s=>s.showWhitespace);
  const compartments=useRef({options:new Compartment(),editable:new Compartment(),language:new Compartment()});
  const original=useRef(editorDocument(initial));
  const jumped=useRef(false);
  const edited=useRef(false);
  const publishText=useEffectEvent(changed);
  useEffect(()=>{
    if(!host.current)return;
    const {bom,doc,eol}=original.current, c=compartments.current;
    const editor=new EditorView({parent:host.current,state:EditorState.create({doc,extensions:[
      // Keep CodeMirror's normalized document so pasted LF/CRLF text is parsed
      // correctly; serialize every line with the original separator on save.
      history(),lineNumbers(),drawSelection(),highlightActiveLine(),syntaxHighlighting(classHighlighter),changedLines,keymap.of([indentWithTab,...defaultKeymap,...historyKeymap]),
      EditorView.contentAttributes.of({"aria-label":"Working file content"}),
      c.options.of([]),c.editable.of([]),c.language.of([]),
      EditorView.updateListener.of(update=>{if(update.docChanged){edited.current=true;publishText(bom+update.state.doc.sliceString(0,undefined,eol));}}),
    ]})});
    view.current=editor;let alive=true;
    editor.focus();
    languageFor(path).then(lang=>{if(alive&&lang)editor.dispatch({effects:c.language.reconfigure(lang)});}).catch(()=>{});
    return()=>{alive=false;view.current=null;editor.destroy();};
  },[path]);
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const doc = editor.state.doc;
    const positions = new Set<number>();
    for (const patch of [displayDiff, diff]) {
      for (const hunk of patch?.hunks ?? []) {
        for (const line of hunk.lines) {
          if (line.kind !== "+" || !line.newNo || line.newNo > doc.lines) continue;
          const current = doc.line(line.newNo);
          const content = line.newNo === 1 ? line.text.replace(/^\uFEFF/, "") : line.text;
          if (current.text === content.replace(/\r$/, "")) positions.add(current.from);
        }
      }
    }
    const sorted = [...positions].sort((a, b) => a - b);
    const effects = [replaceHighlights.of(Decoration.set(sorted.map(position => workingChange.range(position))))];
    const first = sorted[0];
    if (first !== undefined && !jumped.current && !edited.current) {
      jumped.current = true;
      editor.dispatch({ selection:{anchor:first}, effects:[...effects, EditorView.scrollIntoView(first, {y:"center"})] });
    } else editor.dispatch({ effects });
  }, [diff, displayDiff]);
  useEffect(()=>{view.current?.dispatch({effects:compartments.current.options.reconfigure([EditorState.tabSize.of(size),indentUnit.of(" ".repeat(size)),...(whitespace?[highlightWhitespace()]:[])])});},[size,whitespace]);
  useEffect(()=>{view.current?.dispatch({effects:compartments.current.editable.reconfigure([EditorState.readOnly.of(disabled),...(disabled?[EditorState.transactionFilter.of(tr=>tr.docChanged?[]:tr)]:[])])});},[disabled]);
  const convert=()=>{
    const editor=view.current;if(!editor||disabled)return;
    const before=editor.state.sliceDoc(), after=tabsToSpaces(before,size,all);
    if(before!==after)editor.dispatch({changes:{from:0,to:editor.state.doc.length,insert:after},selection:{anchor:Math.min(editor.state.selection.main.head,after.length)},userEvent:"input.indentation"});
    editor.focus();
  };
  return <><div className="file-editor-tools">
    <button type="button" className="btn sm" disabled={disabled||!view.current||!undoDepth(view.current.state)} onClick={()=>{if(view.current){undo(view.current);view.current.focus();}}}>Undo</button>
    <button type="button" className="btn sm" disabled={disabled||!view.current||!redoDepth(view.current.state)} onClick={()=>{if(view.current){redo(view.current);view.current.focus();}}}>Redo</button>
    <button type="button" className={`btn sm ${whitespace?"active":""}`} aria-pressed={whitespace} onClick={()=>useSettings.getState().set({showWhitespace:!whitespace})}>Show whitespace</button>
    <label>Spaces per tab <select className="select" aria-label="Spaces per tab" value={size} disabled={disabled} onChange={e=>setSize(Number(e.target.value))}>{[2,4,8].map(n=><option key={n} value={n}>{n}</option>)}</select></label>
    <label>Convert <select className="select" aria-label="Tab conversion scope" value={all?"all":"indent"} disabled={disabled} onChange={e=>setAll(e.target.value==="all")}><option value="indent">Leading indentation only</option><option value="all">All tabs in the file</option></select></label>
    <button type="button" className="btn sm" disabled={disabled} onClick={convert}>Tabs → spaces</button><span className="muted">{shortcutTitle("Save", "workingFileSave")} · Ctrl+Z undoes</span>
  </div><div className="working-code" ref={host}/></>;
}
