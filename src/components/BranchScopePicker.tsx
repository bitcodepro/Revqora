import { useMemo, useState } from "react";
import { GitBranch } from "lucide-react";
import { Modal } from "./Modal";
import { showDialog } from "../lib/ui";
import type { BranchInfo } from "../lib/types";

const SHOWN = 300;

/** A searchable branch list for choosing the history scope: usable with thousands of branches,
 *  where the scope drop-down becomes too long to scroll. Resolves to a full ref name or null. */
export function pickBranchScope(local: BranchInfo[], remote: BranchInfo[]): Promise<string | null> {
  return showDialog<string | null>((close) => <Picker local={local} remote={remote} close={close} />);
}

function Picker({ local, remote, close }: { local: BranchInfo[]; remote: BranchInfo[]; close: (value: string | null) => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const all = useMemo(() => [
    ...local.map((b) => ({ ref: b.fullName, name: b.name, group: "Local" })),
    ...remote.map((b) => ({ ref: b.fullName, name: b.name, group: "Remote" })),
  ], [local, remote]);
  const matches = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return words.length ? all.filter((b) => words.every((w) => b.name.toLowerCase().includes(w))) : all;
  }, [all, query]);
  const shown = matches.slice(0, SHOWN);
  const choose = (index: number) => { const b = shown[index]; if (b) close(b.ref); };
  return (
    <Modal title="Show history of a branch" subtitle={`${all.length.toLocaleString()} branches`} icon={<GitBranch size={18} />} onClose={() => close(null)}
      onSubmit={() => choose(active)} footer={<><button type="button" className="btn" onClick={() => close(null)}>Cancel</button><button type="submit" className="btn primary" disabled={!shown.length}>Show history</button></>}>
      <input className="input" autoFocus aria-label="Filter branches" placeholder="Type part of a branch name" value={query}
        aria-controls="branch-scope-results" aria-activedescendant={shown[active] ? `branch-scope-${active}` : undefined}
        onChange={(e) => { setQuery(e.target.value); setActive(0); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(shown.length - 1, i + 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
        }} />
      <div id="branch-scope-results" role="listbox" aria-label="Branches" className="branch-scope-results">
        {shown.map((b, i) => (
          <div key={b.ref} id={`branch-scope-${i}`} role="option" aria-selected={i === active} className={`file-row ${i === active ? "selected" : ""}`}
            onMouseEnter={() => setActive(i)} onClick={() => choose(i)}>
            <GitBranch size={13} /> <span className="ellipsis">{b.name}</span><span className="faint" style={{ marginLeft: "auto" }}>{b.group}</span>
          </div>
        ))}
        {!shown.length && <div className="empty">No branch matches.</div>}
        {matches.length > SHOWN && <div className="faint" style={{ padding: 6 }}>{(matches.length - SHOWN).toLocaleString()} more — type more of the name to narrow the list.</div>}
      </div>
    </Modal>
  );
}
