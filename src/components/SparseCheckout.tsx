import { useEffect, useMemo, useState } from "react";
import { FolderMinus, FolderPlus, Loader2, RefreshCw } from "lucide-react";
import { api, errorMessage, isGitError, newOpId } from "../lib/api";
import type { SparseResult, SparseState } from "../lib/types";
import { useRepos } from "../lib/store";
import { endBusy, startBusy, toast } from "../lib/ui";
import { confirmDialog } from "./dialogs";
import { changedAmong, conePreview, coneToPatterns, directoriesOf, normalizeFolder, patternsToFolders } from "../lib/sparse";

const MAX_SHOWN = 12;
const MAX_PICK = 60;

const listOf = (paths: readonly string[]) => (paths.length > MAX_SHOWN ? [...paths.slice(0, MAX_SHOWN), `… and ${paths.length - MAX_SHOWN} more`] : [...paths]);

/** Repository tools tab: sparse checkout (cone / non-cone) and partial clone status. */
export function SparseTab({ root }: { root: string }) {
  const status = useRepos((s) => s.tabs[root]?.status ?? null);
  const [state, setState] = useState<SparseState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tree, setTree] = useState<string[] | null>(null);
  const [folders, setFolders] = useState<string[]>([]);
  const [patterns, setPatterns] = useState("");
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<{ title: string; text: string | null; files: string[] } | null>(null);

  const adopt = (s: SparseState) => {
    setState(s);
    setFolders(s.cone ? s.patterns : []);
    setPatterns(s.cone ? "" : s.patterns.join("\n"));
  };
  const reload = () => {
    api.sparseCheckoutState(root).then(adopt, (e) => setLoadError(errorMessage(e)));
    api.listTree(root, "HEAD").then(setTree, () => setTree([]));
  };
  useEffect(reload, [root]);

  const directories = useMemo(() => directoriesOf(tree ?? []), [tree]);
  const changed = useMemo(() => (status?.files ?? []).filter((f) => !f.untracked).map((f) => f.path), [status]);
  const matches = useMemo(() => {
    const q = pick.trim().toLowerCase();
    return directories.filter((d) => !folders.includes(d) && (!q || d.toLowerCase().includes(q))).slice(0, MAX_PICK);
  }, [directories, folders, pick]);

  if (loadError) return <div className="error-text" role="alert">{loadError}</div>;
  if (!state) return <div className="loading-center" style={{ minHeight: 120 }}><span className="loader" aria-label="Loading sparse checkout state" /></div>;

  /** Runs a change; when Git would delete ignored files, asks first and repeats with consent. */
  const withIgnoredConsent = async (label: string, f: (allowIgnoredLoss: boolean) => Promise<SparseResult>): Promise<SparseResult | null> => {
    try {
      return await f(false);
    } catch (e) {
      if (!isGitError(e) || e.kind !== "sparse-ignored-files") throw e;
      const ok = await confirmDialog({
        title: `${label}: ignored files will be deleted`,
        confirm: "Delete them and continue",
        danger: true,
        message:
          "Git deletes folders that leave the working tree together with the ignored files in them (for example .env files, node_modules or build output). These files are not in the repository and cannot be restored from Undo or a checkpoint. Move the ones you need out of the repository first.",
        details: listOf(e.details),
      });
      return ok ? await f(true) : null;
    }
  };

  const run = async (key: string, label: string, f: (allowIgnoredLoss: boolean) => Promise<SparseResult>) => {
    const id = newOpId();
    setBusy(key);
    startBusy(id, label);
    setOutcome(null);
    try {
      const r = await withIgnoredConsent(label, f);
      if (!r) return;
      adopt(r.state);
      if (r.leftBehind.length) {
        setOutcome({ title: "Git kept these modified files outside the sparse set in the working tree. Commit, stash or discard them, then choose Reapply.", text: r.warning, files: r.leftBehind });
      } else if (r.warning) {
        setOutcome({ title: "Git reported:", text: r.warning, files: [] });
      }
      toast.success(`${label} done`);
    } catch (e) {
      const files = isGitError(e) ? e.details : [];
      setOutcome({ title: errorMessage(e), text: isGitError(e) && e.stderr ? e.stderr : null, files });
      toast.error(e, `${label} failed`);
      api.sparseCheckoutState(root).then(adopt, () => {});
    } finally {
      endBusy(id);
      setBusy(null);
    }
  };

  /** Explains what leaves the working tree before a cone-mode change; true to proceed. */
  const confirmCone = async (title: string, next: string[], confirm: string) => {
    const preview = tree ? conePreview(tree, { enabled: state.enabled, cone: state.cone, folders: state.patterns }, next) : null;
    if (!preview) {
      return confirmDialog({ title, confirm, message: "Git removes tracked files outside the new selection from the working tree. Modified files are kept in place and listed afterwards." });
    }
    const dirty = changedAmong(preview.leaving, changed);
    if (!preview.leaving.length) return true;
    return confirmDialog({
      title,
      confirm,
      danger: dirty.length > 0,
      message: (
        <>
          {preview.leaving.length.toLocaleString()} tracked file{preview.leaving.length === 1 ? "" : "s"} will leave the working tree
          {preview.arriving ? ` and ${preview.arriving.toLocaleString()} will come back` : ""}. They stay in the repository and return when you add their folder again.
          {dirty.length > 0 && <> {dirty.length} of them have local changes: Git keeps those files in place, or refuses on older Git; nothing is discarded.</>}
        </>
      ),
      details: listOf(dirty.length ? dirty : preview.leaving),
    });
  };

  const enable = async () => {
    if (!(await confirmCone("Turn on sparse checkout", folders, "Turn on"))) return;
    await run("enable", "Turn on sparse checkout", (allow) => api.sparseCheckoutSet(root, true, folders, allow));
  };
  const applyFolders = async () => {
    const added = folders.filter((f) => !state.patterns.includes(f));
    const onlyAdds = state.patterns.every((f) => folders.includes(f));
    if (onlyAdds && added.length) {
      await run("apply", "Add sparse folders", (allow) => api.sparseCheckoutAdd(root, added, allow));
      return;
    }
    if (!(await confirmCone("Change sparse folders", folders, "Apply"))) return;
    await run("apply", "Change sparse folders", (allow) => api.sparseCheckoutSet(root, true, folders, allow));
  };
  const applyPatterns = async () => {
    const list = patterns.split(/\r?\n/).filter((l) => l.trim());
    const ok = await confirmDialog({
      title: "Apply sparse patterns",
      confirm: "Apply",
      message: "Git checks out only files matching these gitignore-style patterns and removes other tracked files from the working tree. Modified files are kept in place and listed afterwards.",
      details: listOf(list),
    });
    if (ok) await run("apply", "Apply sparse patterns", () => api.sparseCheckoutSet(root, false, list));
  };
  const switchMode = async () => {
    if (state.cone) {
      const next = coneToPatterns(state.patterns);
      const ok = await confirmDialog({
        title: "Switch to non-cone mode",
        confirm: "Switch",
        message: "Non-cone mode uses gitignore-style patterns. It is slower in large repositories and deprecated by Git, but can select individual files. The current folders become these patterns:",
        details: next,
      });
      if (ok) await run("mode", "Switch to non-cone mode", () => api.sparseCheckoutSet(root, false, next));
    } else {
      const { folders: next, dropped } = patternsToFolders(state.patterns);
      const ok = await confirmDialog({
        title: "Switch to cone mode",
        confirm: "Switch",
        danger: dropped.length > 0,
        message: dropped.length
          ? "Cone mode selects whole folders. These patterns do not name a folder and will be dropped; files they selected may leave the working tree:"
          : `Cone mode selects whole folders. The folders will be: ${next.join(", ") || "(top-level files only)"}.`,
        details: dropped,
      });
      if (ok) await run("mode", "Switch to cone mode", (allow) => api.sparseCheckoutSet(root, true, next, allow));
    }
  };
  const disable = async () => {
    const ok = await confirmDialog({
      title: "Turn off sparse checkout",
      confirm: "Turn off",
      message: "All tracked files come back to the working tree. In a large repository this can take a while and use much more disk space; in a partial clone Git also downloads every missing file. Your folder list is not kept.",
    });
    if (ok) await run("disable", "Turn off sparse checkout", () => api.sparseCheckoutDisable(root));
  };
  const addFolder = (raw: string) => {
    const { folder, error } = normalizeFolder(raw);
    if (!folder) {
      toast.error(error);
      return;
    }
    if (!folders.includes(folder)) setFolders([...folders, folder]);
    setPick("");
  };

  const dirty = state.cone ? folders.length !== state.patterns.length || folders.some((f, i) => f !== state.patterns[i]) : patterns !== state.patterns.join("\n");

  return (
    <div className="vstack sparse-tab" style={{ gap: 10 }}>
      <section className="sparse-section" aria-labelledby="sparse-heading">
        <h3 id="sparse-heading">Sparse checkout</h3>
        <div className="settings-grid">
          <label>Status</label>
          <span>{state.enabled ? <span className="pill green">on</span> : <span className="pill">off — every tracked file is checked out</span>}</span>
          {state.enabled && (
            <>
              <label>Mode</label>
              <span>{state.cone ? "Cone (whole folders)" : "Non-cone (gitignore-style patterns)"}</span>
            </>
          )}
        </div>
        {!state.enabled && <p className="faint">Check out only the folders you work in. Top-level files are always included. Commits, history and branches still cover the whole repository.</p>}

        {(state.cone || !state.enabled) && (
          <>
            <div className="sparse-folders" role="list" aria-label="Sparse checkout folders">
              {folders.length === 0 && <div className="faint" role="listitem">Only top-level files.</div>}
              {folders.map((f) => (
                <div key={f} className="sparse-folder" role="listitem">
                  <span className="mono ellipsis" title={f}>{f}/</span>
                  <button type="button" className="btn sm" aria-label={`Remove folder ${f}`} disabled={!!busy} onClick={() => setFolders(folders.filter((x) => x !== f))}>
                    <FolderMinus size={12} /> Remove
                  </button>
                </div>
              ))}
            </div>
            <form
              className="hstack sparse-pick"
              onSubmit={(e) => {
                e.preventDefault();
                if (pick.trim()) addFolder(pick);
              }}
            >
              <input className="input mono" aria-label="Folder path to add" placeholder={tree === null ? "Loading folders…" : "Type a folder path or filter the list"} value={pick} onChange={(e) => setPick(e.target.value)} />
              <button type="submit" className="btn sm" disabled={!pick.trim() || !!busy}>
                <FolderPlus size={12} /> Add
              </button>
            </form>
            {matches.length > 0 && (
              <div className="sparse-tree" role="list" aria-label="Folders in the repository at HEAD">
                {matches.map((d) => (
                  <button key={d} type="button" role="listitem" className="sparse-tree-item mono" style={{ paddingLeft: 8 + 12 * (d.split("/").length - 1) }} aria-label={`Add folder ${d}`} onClick={() => addFolder(d)}>
                    {d.split("/").pop()}/<span className="faint"> {d}</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        {state.enabled && !state.cone && (
          <div className="field">
            <label htmlFor="sparse-patterns">Patterns (one per line)</label>
            <textarea id="sparse-patterns" className="input mono" rows={6} aria-label="Sparse checkout patterns, one per line" value={patterns} onChange={(e) => setPatterns(e.target.value)} />
          </div>
        )}

        <div className="hstack" style={{ flexWrap: "wrap" }}>
          {!state.enabled ? (
            <button type="button" className="btn primary" disabled={!!busy} onClick={enable}>
              {busy === "enable" && <Loader2 size={14} className="spin" />} Turn on sparse checkout
            </button>
          ) : (
            <>
              <button type="button" className="btn primary" disabled={!!busy || !dirty} onClick={state.cone ? applyFolders : applyPatterns}>
                {busy === "apply" && <Loader2 size={14} className="spin" />} Apply {state.cone ? "folder list" : "patterns"}
              </button>
              <button type="button" className="btn" disabled={!!busy || !dirty} onClick={() => adopt(state)}>
                Undo edits
              </button>
              <button type="button" className="btn" disabled={!!busy} onClick={() => run("reapply", "Reapply sparse checkout", (allow) => api.sparseCheckoutReapply(root, allow))}>
                <RefreshCw size={14} /> Reapply
              </button>
              <button type="button" className="btn" disabled={!!busy} onClick={switchMode}>
                Switch to {state.cone ? "non-cone" : "cone"} mode…
              </button>
              <button type="button" className="btn danger" disabled={!!busy} onClick={disable}>
                Turn off…
              </button>
            </>
          )}
        </div>
        {!state.setSelectsMode && <p className="faint">This Git is older than 2.35, so the mode is chosen with git sparse-checkout init before the folders are set.</p>}
        {outcome && (
          <div className="callout sparse-outcome" role="status">
            <div className="vstack" style={{ gap: 4, minWidth: 0 }}>
              <b>{outcome.title}</b>
              {outcome.files.length > 0 && <div className="code-list">{listOf(outcome.files).join("\n")}</div>}
              {outcome.text && <pre className="sparse-git-message">{outcome.text}</pre>}
            </div>
          </div>
        )}
      </section>

      <section className="sparse-section" aria-labelledby="partial-heading">
        <h3 id="partial-heading">Partial clone</h3>
        {state.partial.length === 0 ? (
          <p className="faint">This is a full clone: every object is stored locally.</p>
        ) : (
          <>
            <div className="settings-grid">
              {state.partial.map((r) => (
                <PartialRow key={r.remote} remote={r.remote} filter={r.filter} />
              ))}
            </div>
            <p className="faint">Git downloads missing file contents from this remote when they are needed (checkout, diff, blame), so those actions need a connection.</p>
          </>
        )}
      </section>
    </div>
  );
}

function PartialRow({ remote, filter }: { remote: string; filter: string | null }) {
  return (
    <>
      <label>{remote}</label>
      <span>
        <span className="pill amber">partial clone</span> <span className="mono">{filter ? `--filter=${filter}` : "no filter recorded"}</span>
      </span>
    </>
  );
}
