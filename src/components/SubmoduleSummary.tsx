import { useEffect, useState } from "react";
import { FolderGit2 } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { relativeTime, shortOid } from "../lib/format";
import type { SubmoduleLog } from "../lib/types";

/** Above a submodule pointer diff: which commits the new pointer adds or drops. */
export function SubmoduleSummary({ root, path, from, to }: { root: string; path: string; from: string | null; to: string | null }) {
  const [log, setLog] = useState<SubmoduleLog | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setLog(null);
    setError(null);
    api.submoduleLog(root, path, from, to).then((l) => { if (alive) setLog(l); }, (e) => { if (alive) setError(errorMessage(e)); });
    return () => { alive = false; };
  }, [root, path, from, to]);
  const range = `${from ? shortOid(from) : "none"} → ${to ? shortOid(to) : "none"}`;
  return (
    <div className="submodule-summary" role="region" aria-label="Submodule change">
      <div className="hstack" style={{ gap: 6 }}>
        <FolderGit2 size={14} />
        <b>Submodule {path}</b>
        <span className="mono faint">{range}</span>
        {log && !log.unavailable && (
          <span className="faint">
            {log.addedCount ? `${log.addedCount} new ${log.addedCount === 1 ? "commit" : "commits"}` : ""}
            {log.addedCount && log.removedCount ? ", " : ""}
            {log.removedCount ? `${log.removedCount} ${log.removedCount === 1 ? "commit" : "commits"} dropped` : ""}
            {!log.addedCount && !log.removedCount ? "same commit" : ""}
          </span>
        )}
      </div>
      {error && <div className="faint">{error}</div>}
      {log?.unavailable && <div className="faint">{log.unavailable}</div>}
      {log && [...log.added.map((c) => ({ c, sign: "+" })), ...log.removed.map((c) => ({ c, sign: "−" }))].map(({ c, sign }) => (
        <div key={sign + c.oid} className="submodule-commit">
          <span className={sign === "+" ? "a" : "d"}>{sign}</span>
          <span className="mono faint">{shortOid(c.oid)}</span>
          <span className="ellipsis">{c.subject}</span>
          <span className="faint">{c.author} · {relativeTime(c.time)}</span>
        </div>
      ))}
      {log && log.addedCount > log.added.length && <div className="faint">… and {log.addedCount - log.added.length} more</div>}
    </div>
  );
}
