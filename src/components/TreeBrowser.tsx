import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, File, Folder, FolderTree, Loader2, Search, X } from "lucide-react";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { syntaxHighlighting } from "@codemirror/language";
import { classHighlighter } from "@lezer/highlight";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { keymap } from "@codemirror/view";
import { api, errorMessage } from "../lib/api";
import { closeOverlay, copyText, toast } from "../lib/ui";
import type { GrepHit } from "../lib/types";
import { languageFor } from "../lib/languages";
import { shortOid } from "../lib/format";

interface Node {
  name: string;
  path: string;
  dirs: Map<string, Node>;
  files: string[];
}

function buildTree(paths: string[]): Node {
  const root: Node = { name: "", path: "", dirs: new Map(), files: [] };
  for (const p of paths) {
    const parts = p.split("/");
    let n = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      if (!n.dirs.has(key)) n.dirs.set(key, { name: key, path: parts.slice(0, i + 1).join("/"), dirs: new Map(), files: [] });
      n = n.dirs.get(key)!;
    }
    n.files.push(p);
  }
  return root;
}

/** Browse every file of a revision, view it with highlighting and search it with git grep. */
export function TreeBrowser({ root, rev }: { root: string; rev: string }) {
  const [paths, setPaths] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [file, setFile] = useState<string | null>(null);
  const [line, setLine] = useState<number | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<GrepHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.listTree(root, rev).then(setPaths, (e) => setErr(errorMessage(e)));
  }, [root, rev]);

  useEffect(() => {
    if (!file) return;
    setText(null);
    api.fileText(root, `${rev}:${file}`).then((t) => setText(t ?? ""), (e) => toast.error(e));
  }, [root, rev, file]);

  useEffect(() => {
    if (text === null || !host.current || !file) return;
    let view: EditorView | null = null;
    let alive = true;
    languageFor(file).then((lang) => {
      if (!alive || !host.current) return;
      view = new EditorView({
        state: EditorState.create({
          doc: text.length > 3_000_000 ? text.slice(0, 3_000_000) : text,
          extensions: [lineNumbers(), highlightActiveLine(), syntaxHighlighting(classHighlighter), highlightSelectionMatches(), keymap.of(searchKeymap), EditorState.readOnly.of(true), EditorView.theme({ "&": { height: "100%" } }), ...(lang ? [lang] : [])],
        }),
        parent: host.current,
      });
      if (line && line <= view.state.doc.lines) {
        const l = view.state.doc.line(line);
        view.dispatch({ selection: { anchor: l.from, head: l.to }, effects: EditorView.scrollIntoView(l.from, { y: "center" }) });
      }
    });
    return () => {
      alive = false;
      view?.destroy();
    };
  }, [text, file, line]);

  const runGrep = async () => {
    if (!query.trim()) return setHits(null);
    setSearching(true);
    try {
      setHits(await api.grep(root, rev, query, true, false));
    } catch (e) {
      toast.error(e, "Search failed");
    } finally {
      setSearching(false);
    }
  };

  const f = filter.trim().toLowerCase();
  const visible = useMemo(() => (paths ? (f ? paths.filter((p) => p.toLowerCase().includes(f)) : paths) : []), [paths, f]);
  const tree = useMemo(() => buildTree(visible), [visible]);

  const renderNode = (n: Node, depth: number): React.ReactNode[] => {
    const out: React.ReactNode[] = [];
    for (const d of [...n.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const isOpen = f ? true : (open[d.path] ?? depth < 1);
      out.push(
        <div key={"d:" + d.path} className="sb-item" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => setOpen((o) => ({ ...o, [d.path]: !isOpen }))}>
          {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          <Folder size={13} style={{ flex: "none", color: "var(--text-faint)" }} />
          <span className="label">{d.name}</span>
        </div>,
      );
      if (isOpen) out.push(...renderNode(d, depth + 1));
    }
    for (const p of [...n.files].sort()) {
      out.push(
        <div
          key={p}
          className={`sb-item ${file === p ? "selected" : ""}`}
          style={{ paddingLeft: 22 + depth * 14 }}
          onClick={() => {
            setLine(null);
            setFile(p);
          }}
          onContextMenu={(e) => (e.preventDefault(), copyText(p, "Path copied"))}
        >
          <File size={13} style={{ flex: "none" }} />
          <span className="label">{p.split("/").pop()}</span>
        </div>,
      );
    }
    return out;
  };

  return (
    <div className="conflict-overlay">
      <div className="cf-head">
        <FolderTree size={18} style={{ color: "var(--accent)" }} />
        <div className="cf-title">
          <span className="p">Files at {/^[0-9a-f]{40}$/.test(rev) ? shortOid(rev) : rev}</span>
          <span className="s">{paths ? `${paths.length.toLocaleString()} files` : "Loading…"}</span>
        </div>
        <div className="search-box" style={{ width: 360, marginLeft: 16 }}>
          {searching ? <Loader2 size={14} className="spin faint" /> : <Search size={14} className="faint" />}
          <input value={query} placeholder="Search file contents (git grep)…" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && runGrep()} />
          {hits && <span className="count">{hits.length} hits</span>}
        </div>
        <div className="spacer" />
        <button className="btn" onClick={closeOverlay}>
          <X size={14} /> Close
        </button>
      </div>
      {err && <div className="empty">{err}</div>}
      {!err && (
        <div style={{ flex: 1, display: "grid", gridTemplateColumns: "320px minmax(0,1fr)", minHeight: 0 }}>
          <div className="changes-left">
            <div style={{ padding: 8 }}>
              <input className="input sm" placeholder="Filter files" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
            <div className="sb-scroll" style={{ padding: "0 6px 10px" }}>
              {hits ? (
                <>
                  <div className="file-list-head">
                    Search results
                    <button className="btn sm ghost" style={{ marginLeft: "auto" }} onClick={() => setHits(null)}>
                      Show files
                    </button>
                  </div>
                  {hits.length === 0 && <div className="cg-empty">No matches.</div>}
                  {hits.map((h, i) => (
                    <div
                      key={i}
                      className={`file-row ${file === h.path && line === h.line ? "selected" : ""}`}
                      style={{ height: "auto", padding: "5px 8px", flexDirection: "column", alignItems: "stretch", gap: 1 }}
                      onClick={() => {
                        setLine(h.line);
                        setFile(h.path);
                      }}
                    >
                      <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
                        {h.path}:{h.line}
                      </span>
                      <span className="mono ellipsis" style={{ fontSize: "var(--fs-xs)", color: "var(--text)" }}>
                        {h.text.trim()}
                      </span>
                    </div>
                  ))}
                </>
              ) : paths ? (
                renderNode(tree, 0)
              ) : (
                <div className="loading-center">
                  <Loader2 className="spin" />
                </div>
              )}
            </div>
          </div>
          <div className="cf-result">
            <div className="cf-pane-head">
              <span className="lbl">{file ?? "Select a file"}</span>
              {file && (
                <button className="btn sm ghost" style={{ marginLeft: "auto" }} onClick={() => copyText(file, "Path copied")}>
                  Copy path
                </button>
              )}
            </div>
            {file && text === null && (
              <div className="loading-center">
                <Loader2 className="spin" />
              </div>
            )}
            <div className="cf-editor" ref={host} key={file ?? ""} />
          </div>
        </div>
      )}
    </div>
  );
}
