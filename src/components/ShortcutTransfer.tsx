import { useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { Download, Upload } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { useSettings } from "../lib/settings";
import { bindingFor, prettyCombo, SHORTCUTS } from "../lib/shortcuts";
import { exportShortcuts, readShortcutFile, reviewShortcutAssignments, SHORTCUT_FILE_LIMIT, type ShortcutImport } from "../lib/shortcutTransfer";
import { showDialog, toast } from "../lib/ui";
import { Modal } from "./Modal";

export function ShortcutTransfer() {
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function importFile(selected?: File) {
    if (!selected || busy) return;
    setBusy(true);
    setError("");
    try {
      if (selected.size > SHORTCUT_FILE_LIMIT) throw Error("Choose a shortcut file smaller than 2 MB.");
      const imported = readShortcutFile(await selected.text());
      await showDialog<void>(close => <ShortcutImportReview imported={imported} filename={selected.name} close={close}/>);
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  async function exportFile() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const path = await save({ title: "Export Revqora shortcuts", defaultPath: "revqora-shortcuts.json", filters: [{ name: "JSON", extensions: ["json"] }] });
      if (path) {
        await api.saveTextFile(path, exportShortcuts(useSettings.getState().shortcuts));
        toast.success("Shortcuts exported");
      }
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  return <>
    <div className="shortcut-transfer-actions">
      <button type="button" className="btn sm" disabled={busy} onClick={() => file.current?.click()}><Upload size={14}/> Import shortcuts…</button>
      <button type="button" className="btn sm" disabled={busy} onClick={() => void exportFile()}><Download size={14}/> Export shortcuts…</button>
      <input type="file" hidden ref={file} accept=".json,.jsonc,.xml,application/json,application/xml" aria-label="Shortcut file" onChange={e => {
        const selected = e.currentTarget.files?.[0];
        e.currentTarget.value = "";
        void importFile(selected);
      }}/>
    </div>
    {error && <div className="callout warn" role="alert">{error}</div>}
  </>;
}

function ShortcutImportReview({ imported, filename, close }: { imported: ShortcutImport; filename: string; close: () => void }) {
  const overrides = useSettings(s => s.shortcuts);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [checked, setChecked] = useState<Record<number, string>>({});
  const [targets, setTargets] = useState<Record<number, string>>({});
  const [error, setError] = useState("");
  const actions = Object.entries(checked).map(([index, id]) => ({ index: Number(index), id, key: imported.rows[Number(index)].key }));
  const plan = reviewShortcutAssignments(overrides, actions);
  const errors = new Map(actions.flatMap((row, i) => plan.errors.has(i) ? [[row.index, plan.errors.get(i)!] as const] : []));
  const search = query.trim().toLowerCase();
  const rows = imported.rows.map((row, index) => ({row, index, target: targets[index] ?? row.suggested})).filter(({row, target}) =>
    `${row.command} ${row.key} ${SHORTCUTS.find(action => action.id === target)?.label ?? ""}`.toLowerCase().includes(search))
    .sort((a, b) => Number(!!b.row.suggested) - Number(!!a.row.suggested));
  const pageSize = 24;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / pageSize) - 1));
  const choose = (index: number, id: string) => {
    setError("");
    setChecked(previous => {
      const next = { ...previous };
      if (id) next[index] = id;
      else delete next[index];
      return next;
    });
  };
  const selectMatches = () => {
    const next: Record<number, string> = {};
    const picked = new Set<string>();
    const matches = imported.rows.flatMap((row, index) => row.suggested && !picked.has(row.suggested) && picked.add(row.suggested)
      ? [{ index, id: row.suggested, key: row.key }] : []);
    const review = reviewShortcutAssignments(overrides, matches);
    // Keep conflicting matches in the preview so the user can decide how to resolve them.
    matches.forEach((row, i) => { if (!review.errors.has(i)) next[row.index] = row.id; });
    setTargets({});
    setChecked(next);
    setError("");
  };
  return <Modal title="Review imported shortcuts" subtitle={`${imported.source} · ${filename}`} wide onClose={close} onSubmit={() => {
    if (!actions.length) return;
    const state = useSettings.getState();
    const latest = reviewShortcutAssignments(state.shortcuts, actions);
    if (latest.errors.size) { setError("Resolve shortcut conflicts before importing."); return; }
    state.set({ shortcuts: latest.next });
    toast.success(`Imported ${actions.length} ${actions.length === 1 ? "shortcut" : "shortcuts"}`);
    close();
  }} footer={<>
    <button type="button" className="btn" onClick={close}>Cancel</button>
    <button type="submit" className="btn primary" disabled={!actions.length || !!errors.size}>Apply {actions.length} selected</button>
  </>}>
    <div className="shortcut-transfer-actions">
      <input className="input" aria-label="Filter imported shortcuts" placeholder="Find imported shortcuts…" value={query} onChange={e => { setQuery(e.target.value); setPage(0); }}/>
      <button type="button" className="btn sm" onClick={selectMatches} disabled={!imported.rows.some(row => row.suggested)}>Select matches</button>
    </div>
    {imported.skipped > 0 && <p className="batch-note">{imported.skipped} unsupported entries skipped. Revqora uses single key combinations.</p>}
    {errors.size > 0 && <p className="red" role="alert">{errors.size} selected assignments have conflicts.</p>}
    {error && <p className="red" role="alert">{error}</p>}
    <div className="shortcut-import-list">
      {rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map(({row, index, target}) => <div className={`shortcut-import-row ${row.suggested ? "shortcut-import-match" : ""}`} key={index}>
        <input type="checkbox" aria-label={`Include ${row.command} ${row.key}`} disabled={!target} checked={index in checked} onChange={e => choose(index, e.target.checked ? target : "")}/>
        <div className="grow-text">
          <b title={row.command}>{row.command}</b>
          <small className="faint">{row.key ? prettyCombo(row.key) : "Unassigned"}{row.context && <span title={row.context}> · Contextual in source</span>}</small>
        </div>
        <label className="field">
          <select className="select" aria-label={`Revqora action for ${row.command} ${row.key}`} value={target} onChange={e => {
            const id = e.target.value;
            setTargets(previous => ({ ...previous, [index]: id }));
            choose(index, id);
          }}>
            <option value="">Choose Revqora action…</option>
            {SHORTCUTS.map(action => <option key={action.id} value={action.id}>{action.label}</option>)}
          </select>
          {target && <small className={errors.has(index) ? "red" : "faint"}>{errors.get(index) ?? `Current · ${prettyCombo(bindingFor(target, overrides)) || "Unassigned"}`}</small>}
        </label>
      </div>)}
      {!rows.length && <div className="cg-empty">No matching shortcuts.</div>}
    </div>
    {rows.length > pageSize && <div className="shortcut-transfer-actions">
      <button type="button" className="btn sm" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>Previous</button>
      <span className="faint">{currentPage * pageSize + 1}–{Math.min((currentPage + 1) * pageSize, rows.length)} of {rows.length}</span>
      <button type="button" className="btn sm" disabled={(currentPage + 1) * pageSize >= rows.length} onClick={() => setPage(currentPage + 1)}>Next</button>
    </div>}
  </Modal>;
}
