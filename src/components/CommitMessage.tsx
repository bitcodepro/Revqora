import type { ReactNode } from "react";
import { Copy, FileText } from "lucide-react";
import { splitCommitMessage } from "../lib/commitMessage";
import { copyText } from "../lib/ui";
import { Modal } from "./Modal";

// Commit text is untrusted. Render text nodes only, with a little block formatting.
function MessageBody({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue; }
    const start = i;
    const fence = lines[i].match(/^\s*(`{3,}|~{3,})/);
    if (fence) {
      i++;
      const code: string[] = [];
      while (i < lines.length) {
        const end = lines[i].match(/^\s*(`{3,}|~{3,})\s*$/);
        if (end && end[1][0] === fence[1][0] && end[1].length >= fence[1].length) { i++; break; }
        code.push(lines[i++]);
      }
      blocks.push(<pre key={start}><code>{code.join("\n")}</code></pre>);
    } else if (/^\s*[-*+]\s+/.test(lines[i])) {
      const items: ReactNode[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) items.push(<li key={i}>{lines[i++].replace(/^\s*[-*+]\s+/, "")}</li>);
      blocks.push(<ul key={start}>{items}</ul>);
    } else {
      const paragraph: string[] = [];
      while (i < lines.length && lines[i].trim() && (i === start || !/^\s*(`{3,}|~{3,}|[-*+]\s+)/.test(lines[i]))) paragraph.push(lines[i++]);
      blocks.push(<p key={start}>{paragraph.join("\n")}</p>);
    }
  }
  return <div className="commit-message-body">{blocks}</div>;
}

export function CommitMessageDialog({ subject, body, oid, author, onClose }: {
  subject: string; body: string; oid: string; author: string; onClose: () => void;
}) {
  const { description, trailers } = splitCommitMessage(body);
  return (
    <Modal title="Commit message" subtitle={`${oid.slice(0, 12)} · ${author}`} icon={<FileText size={18} />} wide onClose={onClose}
      footer={<>
        <button type="button" className="btn" onClick={() => copyText(subject + (body ? "\n\n" + body : ""), "Commit message copied")}><Copy size={14} /> Copy message</button>
        <button type="button" className="btn primary" onClick={onClose}>Close</button>
      </>}>
      <article className="commit-message selectable">
        <h2>{subject}</h2>
        {description && <MessageBody text={description} />}
        {trailers.length > 0 && <details className="commit-message-trailers">
          <summary>Contributors &amp; sign-offs <span className="faint">({trailers.length})</span></summary>
          <dl>{trailers.map((t, i) => <div key={i}><dt>{t.key}</dt><dd>{t.value}</dd></div>)}</dl>
        </details>}
      </article>
    </Modal>
  );
}
