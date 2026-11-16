import { useEffect, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { Copy, Download, Palette, RotateCcw, Trash2, Upload } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { useSettings } from "../lib/settings";
import { setThemePreview } from "../lib/themeApply";
import {
  BUILTIN_PALETTES, BUILTIN_THEMES, CUSTOM_THEME_LIMIT, THEME_FILE_LIMIT, THEME_GROUPS, THEME_NAME_LIMIT, THEME_TOKENS,
  cleanThemeName, colorHex, customThemeId, customThemePref, duplicateTheme, formatColor, isBuiltinThemeId, newThemeId,
  normalizeColor, parseCssColor, parseThemeFile, serializeTheme, themeLabel, uniqueThemeName,
  type CustomTheme, type ThemeTokenName,
} from "../lib/themes";
import { showDialog, toast } from "../lib/ui";
import { Modal } from "./Modal";

/** Opens the editor on the custom theme in use, or on `themeId`. */
export function themeEditorDialog(themeId?: string): Promise<void> {
  return showDialog<void>(close => <ThemeEditor initialId={themeId} close={() => close()} />);
}

const sameColors = (a: CustomTheme, b: CustomTheme) =>
  THEME_TOKENS.every(({ name }) => (a.colors[name] ?? "") === (b.colors[name] ?? ""));

function ThemeEditor({ initialId, close }: { initialId?: string; close: () => void }) {
  const themes = useSettings(s => s.customThemes);
  const active = useSettings(s => s.theme);
  const [draft, setDraft] = useState<CustomTheme | null>(() => {
    const state = useSettings.getState();
    const id = initialId ?? customThemeId(state.theme);
    return state.customThemes.find(theme => theme.id === id) ?? null;
  });
  const [source, setSource] = useState<string>(() => {
    const pref = useSettings.getState().theme;
    return pref === "system" ? "dark" : pref;
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const saved = draft ? themes.find(theme => theme.id === draft.id) ?? null : null;
  const dirty = !!draft && !!saved && (draft.name !== saved.name || !sameColors(draft, saved));
  const name = draft ? cleanThemeName(draft.name) : "";
  const nameTaken = !!draft && themes.some(theme => theme.id !== draft.id && theme.name.toLowerCase() === name.toLowerCase());
  const nameError = !draft ? "" : !name ? "Enter a name for the theme." : nameTaken ? "Another custom theme already has this name." : "";
  const full = themes.length >= CUSTOM_THEME_LIMIT;

  // The draft is shown on the whole app (and detached panels) while the editor is open.
  useEffect(() => { setThemePreview(draft); }, [draft]);
  useEffect(() => () => setThemePreview(null), []);

  const sourceValid = isBuiltinThemeId(source) || themes.some(theme => customThemePref(theme.id) === source);
  const sourceValue = sourceValid ? source : "dark";

  function open(theme: CustomTheme | null) {
    setDraft(theme);
    setConfirmDelete(false);
    setError("");
  }

  function add(theme: CustomTheme) {
    const state = useSettings.getState();
    state.set({ customThemes: [...state.customThemes, theme], theme: customThemePref(theme.id) });
    open(theme);
  }

  function duplicate() {
    if (full) { setError(`Revqora keeps up to ${CUSTOM_THEME_LIMIT} custom themes. Delete one first.`); return; }
    const state = useSettings.getState();
    const from = isBuiltinThemeId(sourceValue) ? sourceValue : state.customThemes.find(theme => customThemePref(theme.id) === sourceValue);
    if (!from) return;
    const copy = duplicateTheme(from, state.customThemes);
    add(copy);
    toast.success(`Created “${copy.name}”`);
  }

  function saveDraft() {
    if (!draft || !dirty) return;
    if (nameError) { setError(nameError); return; }
    const state = useSettings.getState();
    if (!state.customThemes.some(theme => theme.id === draft.id)) { setError("This theme was deleted."); return; }
    const next: CustomTheme = { ...draft, name };
    state.set({ customThemes: state.customThemes.map(theme => theme.id === next.id ? next : theme) });
    open(next);
    toast.success(`Saved “${next.name}”`);
  }

  function remove() {
    if (!draft) return;
    const state = useSettings.getState();
    state.set({
      customThemes: state.customThemes.filter(theme => theme.id !== draft.id),
      // The deleted theme's base keeps the look as close as a built-in theme can.
      ...(state.theme === customThemePref(draft.id) ? { theme: draft.base } : {}),
    });
    toast.success(`Deleted “${saved?.name ?? draft.name}”`);
    open(null);
  }

  async function exportDraft() {
    if (!draft || busy) return;
    setBusy(true);
    setError("");
    try {
      const fileName = (name || "theme").replace(/[^\p{L}\p{N} _.-]/gu, "").trim().replace(/\s+/g, "-").toLowerCase() || "theme";
      const path = await save({ title: "Export Revqora theme", defaultPath: `${fileName}.revqora-theme.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
      if (path) {
        await api.saveTextFile(path, serializeTheme({ ...draft, name: name || "Custom theme" }));
        toast.success("Theme exported");
      }
    } catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }

  async function importFile(selected?: File) {
    if (!selected || busy) return;
    setBusy(true);
    setError("");
    try {
      if (useSettings.getState().customThemes.length >= CUSTOM_THEME_LIMIT) throw Error(`Revqora keeps up to ${CUSTOM_THEME_LIMIT} custom themes. Delete one first.`);
      if (selected.size > THEME_FILE_LIMIT) throw Error("Choose a theme file smaller than 256 KB.");
      const imported = parseThemeFile(await selected.text());
      const current = useSettings.getState().customThemes;
      const theme: CustomTheme = { id: newThemeId(current), name: uniqueThemeName(imported.name, current), base: imported.base, colors: imported.colors };
      add(theme);
      toast.success(`Imported “${theme.name}”`);
    } catch (e) { setError(`Theme not imported. ${errorMessage(e)}`); }
    finally { setBusy(false); }
  }

  function setColor(token: ThemeTokenName, value: string | null) {
    setDraft(current => {
      if (!current) return current;
      const colors = { ...current.colors };
      // A colour equal to the base is not an override.
      if (value === null || value === normalizeColor(BUILTIN_PALETTES[current.base][token])) delete colors[token];
      else colors[token] = value;
      return { ...current, colors };
    });
  }

  const changed = draft ? Object.keys(draft.colors).length : 0;
  const isActive = !!draft && active === customThemePref(draft.id);

  return <Modal title="Theme editor" icon={<Palette size={18}/>} subtitle="Duplicate a theme, then change its colours. Changes show at once." wide sizeKey="Theme editor"
    onClose={close} onSubmit={saveDraft} footer={<>
      <span className="faint" role="status">{!draft ? "" : dirty ? "Unsaved changes" : "All changes saved"}</span>
      <div className="spacer"/>
      {dirty && <button type="button" className="btn" onClick={() => open(saved)}>Discard changes</button>}
      <button type="button" className="btn" onClick={close}>{dirty ? "Close without saving" : "Close"}</button>
      <button type="submit" className="btn primary" disabled={!dirty || !!nameError}>Save theme</button>
    </>}>
    <div className="theme-editor-bar">
      <label className="theme-editor-field">
        <span>Custom theme</span>
        <select className="select" value={draft?.id ?? ""} disabled={dirty || !themes.length}
          title={dirty ? "Save or discard your changes first" : undefined}
          onChange={e => open(themes.find(theme => theme.id === e.target.value) ?? null)}>
          <option value="">{themes.length ? "Choose a theme to edit…" : "No custom themes yet"}</option>
          {themes.map(theme => <option key={theme.id} value={theme.id}>{theme.name}</option>)}
        </select>
      </label>
      <label className="theme-editor-field">
        <span>New theme from</span>
        <select className="select" value={sourceValue} onChange={e => setSource(e.target.value)}>
          {BUILTIN_THEMES.map(theme => <option key={theme.id} value={theme.id}>{theme.label}</option>)}
          {themes.length > 0 && <optgroup label="Custom themes">
            {themes.map(theme => <option key={theme.id} value={customThemePref(theme.id)}>{theme.name}</option>)}
          </optgroup>}
        </select>
      </label>
      <button type="button" className="btn sm" disabled={dirty || busy} title={dirty ? "Save or discard your changes first" : undefined} onClick={duplicate}><Copy size={14}/> Duplicate</button>
      <button type="button" className="btn sm" disabled={dirty || busy} title={dirty ? "Save or discard your changes first" : undefined} onClick={() => file.current?.click()}><Upload size={14}/> Import theme…</button>
      <input type="file" hidden ref={file} accept=".json,application/json" aria-label="Theme file" onChange={e => {
        const selected = e.currentTarget.files?.[0];
        e.currentTarget.value = "";
        void importFile(selected);
      }}/>
    </div>
    {error && <div className="callout warn" role="alert">{error}</div>}
    {!draft && <p className="faint theme-editor-empty">
      Choose a theme under <b>New theme from</b> and select <b>Duplicate</b>, or import a theme file. Built-in themes cannot be changed.
    </p>}
    {draft && <>
      <div className="theme-editor-bar">
        <label className="theme-editor-field grow">
          <span>Name</span>
          <input className="input" value={draft.name} maxLength={THEME_NAME_LIMIT} aria-invalid={!!nameError} spellCheck={false}
            onChange={e => { setError(""); setDraft({ ...draft, name: e.target.value }); }}/>
        </label>
        {!isActive && <button type="button" className="btn sm" disabled={dirty} title={dirty ? "Save or discard your changes first" : undefined}
          onClick={() => useSettings.getState().set({ theme: customThemePref(draft.id) })}>Use this theme</button>}
        <button type="button" className="btn sm" disabled={busy} onClick={() => void exportDraft()}><Download size={14}/> Export theme…</button>
        <button type="button" className="btn sm" onClick={() => setConfirmDelete(true)}><Trash2 size={14}/> Delete…</button>
      </div>
      {nameError && <p className="red" role="alert">{nameError}</p>}
      {confirmDelete && <div className="callout danger theme-editor-confirm" role="group" aria-label="Delete theme">
        <span>Delete “{saved?.name ?? draft.name}”? This cannot be undone.{isActive ? ` Revqora switches to ${themeLabel(draft.base, [])}.` : ""}</span>
        <button type="button" className="btn sm danger" autoFocus onClick={remove}>Delete theme</button>
        <button type="button" className="btn sm" onClick={() => setConfirmDelete(false)}>Keep</button>
      </div>}
      <p className="faint theme-editor-note">
        Based on {themeLabel(draft.base, [])} ({BUILTIN_THEMES.find(theme => theme.id === draft.base)!.scheme} colour scheme) · {changed} of {THEME_TOKENS.length} colours changed
        {isActive ? " · in use" : " · previewed while this editor is open"}
      </p>
      <ThemeSample/>
      {THEME_GROUPS.map(group => <TokenGroup key={group.id} group={group.id} label={group.label} theme={draft} setColor={setColor}/>)}
    </>}
  </Modal>;
}

function TokenGroup({ group, label, theme, setColor }: {
  group: string; label: string; theme: CustomTheme; setColor: (token: ThemeTokenName, value: string | null) => void;
}) {
  const tokens = useMemo(() => THEME_TOKENS.filter(item => item.group === group), [group]);
  return <fieldset className="theme-group">
    <legend>{label}</legend>
    <div className="theme-tokens">
      {tokens.map(item => {
        const own = theme.colors[item.name];
        const value = own ?? normalizeColor(BUILTIN_PALETTES[theme.base][item.name]) ?? "#000000";
        return <TokenRow key={item.name} label={item.label} token={item.name} value={value} overridden={own !== undefined} setColor={setColor}/>;
      })}
    </div>
  </fieldset>;
}

function TokenRow({ label, token, value, overridden, setColor }: {
  label: string; token: ThemeTokenName; value: string; overridden: boolean; setColor: (token: ThemeTokenName, value: string | null) => void;
}) {
  const [text, setText] = useState(value);
  // Follow outside changes (colour picker, reset, another theme) without rewriting what is being typed.
  useEffect(() => { setText(current => normalizeColor(current) === value ? current : value); }, [value]);
  const color = parseCssColor(value) ?? { r: 0, g: 0, b: 0, a: 1 };
  const invalid = normalizeColor(text) === null;
  return <div className={`theme-token ${overridden ? "changed" : ""}`}>
    <span className="theme-token-label" title={token}>{label}</span>
    <span className="theme-swatch" aria-hidden="true"><i style={{ background: value }}/></span>
    <input type="color" value={colorHex(color)} aria-label={`${label}: colour`} title={`${label}: pick a colour`}
      onChange={e => {
        const picked = parseCssColor(e.target.value);
        // The picker has no opacity: keep the opacity the colour already has.
        if (picked) setColor(token, formatColor({ ...picked, a: color.a }));
      }}/>
    <input className="input sm" value={text} spellCheck={false} autoComplete="off" maxLength={64} aria-label={`${label}: colour value`} aria-invalid={invalid}
      title="Hex, rgb() or hsl() colour; rgba() and hsla() set the opacity"
      onChange={e => {
        setText(e.target.value);
        const next = normalizeColor(e.target.value);
        if (next) setColor(token, next);
      }}
      onBlur={() => setText(value)}/>
    <button type="button" className="icon-btn sm" disabled={!overridden} aria-label={`Reset ${label} to the base theme`} title="Reset to the base theme"
      onClick={() => setColor(token, null)}><RotateCcw size={13}/></button>
    {invalid && <small className="red theme-token-error" role="alert">Use a hex, rgb() or hsl() colour.</small>}
  </div>;
}

const LANES = Array.from({ length: 12 }, (_, index) => index);

/** A small sample of the main colours: the dialog covers most of the app while editing. */
function ThemeSample() {
  return <div className="theme-sample" role="group" aria-label="Preview">
    <div className="theme-sample-panel">
      <div className="theme-sample-row"><b>Text</b> <span className="ts-dim">secondary</span> <span className="ts-faint">faint</span> <span className="ts-accent">link</span></div>
      <div className="theme-sample-row ts-selected">Selected row <span className="ts-chip">main</span></div>
      <div className="theme-sample-row ts-status">
        <span style={{ color: "var(--green)" }}>added</span> <span style={{ color: "var(--red)" }}>deleted</span> <span style={{ color: "var(--amber)" }}>warning</span> <span style={{ color: "var(--blue)" }}>info</span>
        <span className="ts-button">Button</span>
      </div>
      <svg className="theme-sample-lanes" viewBox="0 0 240 20" role="img" aria-label="Graph lane colours">
        {LANES.map(lane => <g key={lane}>
          <line x1={10 + lane * 20} y1="0" x2={10 + lane * 20} y2="20" stroke={`var(--lane-${lane})`} strokeWidth="2"/>
          <circle cx={10 + lane * 20} cy="10" r="4.5" fill={`var(--lane-${lane})`}/>
        </g>)}
      </svg>
    </div>
    <pre className="theme-sample-code" aria-label="Diff and syntax colours">
      <span className="ts-line ts-hunk">@@ -1,3 +1,3 @@</span>
      <span className="ts-line"><span className="tok-comment">// greet the user</span></span>
      <span className="ts-line ts-del">- <span className="tok-keyword">const</span> <span className="tok-property">name</span> <span className="tok-operator">=</span> <span className="ts-del-word"><span className="tok-string">"world"</span></span>;</span>
      <span className="ts-line ts-add">+ <span className="tok-keyword">const</span> <span className="tok-property">name</span> <span className="tok-operator">=</span> <span className="ts-add-word"><span className="tok-function">user</span>(<span className="tok-number">42</span>)</span>;</span>
      <span className="ts-line"><span className="tok-tag">&lt;Hello</span> <span className="tok-attr">to</span>=<span className="tok-type">Name</span> <span className="tok-meta">@meta</span> <span className="tok-tag">/&gt;</span></span>
    </pre>
  </div>;
}
