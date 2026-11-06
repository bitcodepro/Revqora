import { useEffect, useRef, useState } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, highlightWhitespace, keymap, lineNumbers } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo, undoDepth, redoDepth } from "@codemirror/commands";
import { indentUnit, syntaxHighlighting } from "@codemirror/language";
import { classHighlighter } from "@lezer/highlight";
import { api, errorMessage } from "../lib/api";
import { editorDocument, tabsToSpaces } from "../lib/textEditing";
import { languageFor } from "../lib/languages";
import { useSettings } from "../lib/settings";
import { useRepos } from "../lib/store";
import { showDialog, useUi } from "../lib/ui";
import { Modal } from "./Modal";
import { confirmDialog } from "./dialogs";
import "../styles/fileEditor.css";

type Snapshot = {content: string; revision: string};
export function editWorkingFile(root: string, path: string) {
  return showDialog<void>(close => <WorkingFileEditor root={root} path={path} close={close}/>);
}
function WorkingFileEditor({root,path,close}: {root:string;path:string;close:()=>void}) {
  const [file,setFile] = useState<Snapshot|null>(null), [text,setText] = useState(""), [loading,setLoading] = useState(true), [saving,setSaving] = useState(false), [error,setError] = useState(""), [epoch,setEpoch] = useState(0);
  const mounted = useRef(true);
  const dirty = !!file && text !== file.content;
  useEffect(() => { mounted.current=true; return () => {mounted.current=false;}; }, []);
  useEffect(() => {
    let alive=true;setLoading(true);setError("");
    api.workingFileRead(root,path).then(value=>{editorDocument(value.content);if(alive){setFile(value);setText(value.content);}}, e=>{if(alive)setError(errorMessage(e));}).catch(e=>{if(alive)setError(errorMessage(e));}).finally(()=>{if(alive)setLoading(false);});
    return()=>{alive=false;};
  },[root,path,epoch]);
  const discard = () => !dirty || confirmDialog({title:"Discard editor changes?",message:"Your unsaved draft will be discarded. The file on disk is kept.",confirm:"Discard draft",danger:true});
  const onClose = async () => {if(!saving && await discard())close();};
  const reload = async () => {if(!saving && await discard())setEpoch(e=>e+1);};
  const save = async () => {
    if(!file||loading||saving||!dirty)return;
    setSaving(true);setError("");
    try {
      const result=await api.workingFileSave(root,path,file.revision,text);
      if(!mounted.current)return;
      setFile(result.file);
      useUi.getState().toast({kind:"success",title:"Working file saved",detail:"Staging is unchanged.",action:result.backupPath?{label:"Open original backup",run:()=>{void api.openPath(result.backupPath!);}}:undefined});
      void useRepos.getState().refresh(root,{status:true,layers:true});
    } catch(e) {if(mounted.current)setError(errorMessage(e));}
    finally {if(mounted.current)setSaving(false);}
  };
  return <Modal title={`Edit working file · ${path}`} subtitle="Changes stay in your working copy until you stage them." wide onClose={()=>void onClose()} footer={<>
    <span className="muted" role="status">{loading?"Loading…":!file?"File not loaded":dirty?"Unsaved changes":"Saved"}</span><button type="button" className="btn" disabled={saving||loading} onClick={()=>void reload()}>Reload from disk</button><button type="button" className="btn" disabled={saving} onClick={()=>void onClose()}>Close</button><button type="button" className="btn primary" disabled={!dirty||loading||saving} onClick={()=>void save()}>{saving?"Saving…":"Save file"}</button>
  </>}><section className="working-file-editor" onKeyDownCapture={e=>{if((e.ctrlKey||e.metaKey)&&!e.altKey&&!e.shiftKey&&e.key.toLowerCase()==="s"){e.preventDefault();e.stopPropagation();void save();}}}>
    {error&&<div className="callout warn" role="alert">{error}</div>}
    {loading?<div className="loading-center">Loading working file…</div>:file&&<WorkingCode key={epoch} path={path} initial={text} disabled={saving} changed={setText}/>}
  </section></Modal>;
}
function WorkingCode({path,initial,disabled,changed}: {path:string;initial:string;disabled:boolean;changed:(text:string)=>void}) {
  const host=useRef<HTMLDivElement>(null),view=useRef<EditorView|null>(null);
  const [size,setSize]=useState(4),[all,setAll]=useState(false);
  const whitespace=useSettings(s=>s.showWhitespace);
  const compartments=useRef({options:new Compartment(),editable:new Compartment(),language:new Compartment()});
  const original=useRef(editorDocument(initial));
  useEffect(()=>{
    if(!host.current)return;
    const {bom,doc,eol}=original.current, c=compartments.current;
    const editor=new EditorView({parent:host.current,state:EditorState.create({doc,extensions:[
      // Keep CodeMirror's normalized document so pasted LF/CRLF text is parsed
      // correctly; serialize every line with the original separator on save.
      history(),lineNumbers(),drawSelection(),highlightActiveLine(),syntaxHighlighting(classHighlighter),keymap.of([indentWithTab,...defaultKeymap,...historyKeymap]),
      EditorView.contentAttributes.of({"aria-label":"Working file content"}),
      c.options.of([]),c.editable.of([]),c.language.of([]),
      EditorView.updateListener.of(update=>{if(update.docChanged)changed(bom+update.state.doc.sliceString(0,undefined,eol));}),
    ]})});
    view.current=editor;let alive=true;
    languageFor(path).then(lang=>{if(alive&&lang)editor.dispatch({effects:c.language.reconfigure(lang)});}).catch(()=>{});
    return()=>{alive=false;view.current=null;editor.destroy();};
  },[path,changed]);
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
    <button type="button" className="btn sm" disabled={disabled} onClick={convert}>Tabs → spaces</button><span className="muted">Ctrl+S saves · Ctrl+Z undoes</span>
  </div><div className="working-code" ref={host}/></>;
}
