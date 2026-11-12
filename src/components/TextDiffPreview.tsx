import { useEffect, useState } from "react";
import { api, errorMessage } from "../lib/api";
import { TEXT_ENCODINGS } from "../lib/textEncodings";
import type { BlobSpec, DecodedText } from "../lib/types";

function useTextSide(root: string, spec: BlobSpec | null, revision: string, encoding: string) {
  const source = spec?.rev, path = spec?.worktree;
  const [result, setResult] = useState<{text?: DecodedText | null; error?: string}>();
  useEffect(() => {
    if (!source && !path) return;
    let current = true;
    setResult(undefined);
    api.textBlob(root, { rev: source, worktree: path }, encoding || null).then(
      text => { if (current) setResult({text}); },
      error => { if (current) setResult({error: errorMessage(error)}); },
    );
    return () => { current = false; };
  }, [root, source, path, revision, encoding]);
  return source || path ? result : null;
}

export function TextDiffPreview({ root, before, after, revision, fallback }: {
  root: string; before: BlobSpec | null; after: BlobSpec | null; revision: string; fallback: React.ReactNode;
}) {
  const [encoding, setEncoding] = useState("");
  const old = useTextSide(root, before, revision, encoding);
  const next = useTextSide(root, after, revision, encoding);
  const sides = [{label: "Before", result: old}, {label: "After", result: next}].filter(side => side.result !== null);
  const loading = sides.some(side => side.result === undefined);
  const textAvailable = sides.some(side => side.result?.text);
  return <section className="decoded-preview" aria-label="File contents preview">
    <div className="decoded-preview-tools">
      <label>View as <select className="select" aria-label="Preview encoding" value={encoding} onChange={e => setEncoding(e.target.value)}>
        <option value="">Automatic encoding</option>
        {TEXT_ENCODINGS.map(option => <option key={option}>{option}</option>)}
      </select></label>
    </div>
    {loading ? <div className="loading-center" role="status" aria-label="Decoding file contents"><span className="loader" aria-hidden="true"/></div>
      : !textAvailable && !sides.some(side => side.result?.error) ? encoding ? <div className="empty">No readable text with this encoding.</div> : fallback
      : <div className="decoded-preview-sides">{sides.map(({label, result}) => <div key={label} className="decoded-preview-side">
        <header><b>{label}</b>{result?.text && <span className="pill">{result.text.encoding}{result.text.bom ? " · BOM" : ""}{result.text.guessed ? " · detected" : ""}</span>}</header>
        {result?.text ? <pre>{result.text.content}</pre> : <div className="callout warn">{result?.error ?? "No readable text with this encoding."}</div>}
      </div>)}</div>}
  </section>;
}
