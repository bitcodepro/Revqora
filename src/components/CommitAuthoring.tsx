import { useEffect, useMemo, useState } from "react";
import { Combine, Loader2, UserPlus } from "lucide-react";
import { api, errorMessage, isGitError } from "../lib/api";
import * as A from "../lib/actions";
import { getTab } from "../lib/store";
import { toast } from "../lib/ui";
import { showDialog } from "../lib/ui";
import type { CommitAuthor } from "../lib/types";
import { formatPerson, parsePerson, type Person } from "../lib/commitTrailers";
import { Modal } from "./Modal";

/** Searchable list of people from recent history; also accepts a typed `Name <email>`. */
export function coAuthorDialog(root: string, chosen: Person[]): Promise<Person | null> {
  return showDialog<Person | null>((close) => <CoAuthorBody root={root} chosen={chosen} close={close} />);
}

function CoAuthorBody({ root, chosen, close }: { root: string; chosen: Person[]; close: (v: Person | null) => void }) {
  const [authors, setAuthors] = useState<CommitAuthor[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    let alive = true;
    api.commitAuthors(root).then((a) => alive && setAuthors(a), (e) => alive && (setError(errorMessage(e)), setAuthors([])));
    return () => { alive = false; };
  }, [root]);
  const taken = (email: string) => chosen.some((p) => p.email.toLowerCase() === email.toLowerCase());
  const q = query.trim().toLowerCase();
  const matches = useMemo(
    () => (authors ?? []).filter((a) => !q || a.name.toLowerCase().includes(q) || a.email.toLowerCase().includes(q)).slice(0, 100),
    [authors, q],
  );
  const typed = q.includes("<") ? parsePerson(query) : null;
  const typedError = q.includes("<") && !typed ? "Use the form Name <email@example.com>" : null;
  const submit = () => {
    if (typed && !taken(typed.email)) close(typed);
    else if (!typed && matches.length === 1 && !taken(matches[0].email)) close(matches[0]);
  };
  return (
    <Modal title="Add co-author" subtitle="Adds a Co-authored-by trailer to the description." icon={<UserPlus size={18} />} onClose={() => close(null)} onSubmit={submit}
      footer={<><button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
        <button type="button" className="btn primary" disabled={!typed || taken(typed.email)} onClick={submit}>Add typed co-author</button></>}>
      <input className="input" autoFocus aria-label="Search people or type Name <email>" placeholder="Search people, or type Name <email>" value={query} onChange={(e) => setQuery(e.target.value)} />
      {typedError && <div className="faint" role="status" style={{ marginTop: 6 }}>{typedError}</div>}
      {error && <div className="callout danger" style={{ marginTop: 8 }}>{error}</div>}
      <div role="listbox" aria-label="People from recent history" style={{ maxHeight: 320, overflow: "auto", marginTop: 8 }}>
        {!authors && <div className="faint"><Loader2 size={14} className="spin" /> Reading recent history…</div>}
        {authors && !matches.length && <div className="faint">No matching people in the last 2000 commits.</div>}
        {matches.map((a) => (
          <button key={a.email.toLowerCase()} type="button" role="option" aria-selected={false} className="btn ghost" disabled={taken(a.email)}
            style={{ display: "flex", width: "100%", justifyContent: "space-between", textAlign: "left" }}
            title={taken(a.email) ? "Already a co-author" : `${a.commits} commits`} onClick={() => close({ name: a.name, email: a.email })}>
            <span>{formatPerson(a)}</span><span className="faint">{a.commits}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

/** Optional extra message for a squash! commit; null when cancelled. */
export function squashMessageDialog(subject: string): Promise<string | null> {
  return showDialog<string | null>((close) => <SquashBody subject={subject} close={close} />);
}

function SquashBody({ subject, close }: { subject: string; close: (v: string | null) => void }) {
  const [text, setText] = useState("");
  return (
    <Modal title="Create squash! commit" subtitle={`Commits the staged changes as squash! ${subject}`} icon={<Combine size={18} />} onClose={() => close(null)}
      footer={<><button type="button" className="btn" onClick={() => close(null)}>Cancel</button>
        <button type="button" className="btn primary" onClick={() => close(text)}>Create squash! commit</button></>}>
      <textarea className="textarea" rows={4} autoFocus aria-label="Squash message (optional)" placeholder="Message to combine with the target commit (optional)" value={text} onChange={(e) => setText(e.target.value)} />
    </Modal>
  );
}

/** Why fixup!/squash! for this commit is unavailable, or null when it can run. */
export function fixupBlocker(root: string, isMerge: boolean, kind: "fixup" | "squash"): string | null {
  const tab = getTab(root);
  const op = tab?.info?.state.kind ?? "none";
  if (op !== "none") return `Finish or abort the current ${op} first`;
  if (isMerge && kind === "squash") return "Squashing into a merge commit is not supported";
  const files = tab?.status?.files ?? [];
  if (!files.some((f) => !f.conflict && f.index !== ".")) return "Stage the changes to commit first";
  return null;
}

/** Commits the staged changes with `git commit --fixup` / `--squash` for this commit. */
export async function createFixupCommit(root: string, oid: string, subject: string, kind: "fixup" | "squash") {
  let message: string | null = null;
  if (kind === "squash") {
    message = await squashMessageDialog(subject);
    if (message === null) return;
  }
  const expectedState = await A.prepareOperation(root);
  if (!expectedState) return;
  const sign = await api.signingGet(root).then((c) => c.signCommits, () => null);
  try {
    const created = await api.fixupCommit(root, oid, { kind, message, sign }, expectedState);
    toast.success(`Created ${kind}! commit ${created.slice(0, 8)}`, subject);
  } catch (e) {
    if (isGitError(e) && e.kind === "identity") {
      toast.error(e, "Set your Git identity first");
      return;
    }
    toast.error(e, `Could not create the ${kind}! commit`);
  }
}