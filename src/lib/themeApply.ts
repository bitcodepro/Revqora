// Puts the chosen theme on the main document. Detached panel windows mirror the root
// element's `data-theme`, `data-contrast` and inline style (see PanelWindows), so they follow.
import { themeEnvironment, useSettings } from "./settings";
import { isThemeToken, normalizeColor, resolveCustomTheme, resolveTheme, type CustomTheme } from "./themes";

let preview: CustomTheme | null = null;
let applied: string[] = [];

/**
 * `data-theme` carries the colour scheme (light / dark) and `data-contrast="more"` selects the
 * high-contrast palette of theme.css. A custom theme adds its colours as inline custom
 * properties: each one is a known token set through the CSSOM with a colour Revqora wrote
 * itself (`normalizeColor`), never text taken from a file.
 */
export function applyTheme() {
  const { theme, customThemes } = useSettings.getState();
  const resolved = preview ? resolveCustomTheme(preview) : resolveTheme(theme, customThemes, themeEnvironment());
  const root = document.documentElement;
  if (root.dataset.theme !== resolved.scheme) root.dataset.theme = resolved.scheme;
  if (resolved.contrast) { if (root.dataset.contrast !== "more") root.dataset.contrast = "more"; }
  else if (root.dataset.contrast !== undefined) delete root.dataset.contrast;
  const next: string[] = [];
  for (const [name, value] of Object.entries(resolved.colors)) {
    const color = isThemeToken(name) ? normalizeColor(value) : null;
    if (!color) continue;
    if (root.style.getPropertyValue(name) !== color) root.style.setProperty(name, color);
    next.push(name);
  }
  for (const name of applied) if (!next.includes(name)) root.style.removeProperty(name);
  applied = next;
}

/** Shows an unsaved theme (the editor's draft) instead of the chosen one; null returns to the setting. */
export function setThemePreview(theme: CustomTheme | null) {
  preview = theme;
  applyTheme();
}

let installed = false;
/** Re-applies the theme when the setting, a custom theme or the system preference changes. */
export function installThemeSync() {
  if (installed) return;
  installed = true;
  useSettings.subscribe((state, previous) => {
    if (state.theme !== previous.theme || state.customThemes !== previous.customThemes) applyTheme();
  });
  for (const query of ["(prefers-color-scheme: light)", "(prefers-contrast: more)", "(forced-colors: active)"]) {
    window.matchMedia(query).addEventListener("change", applyTheme);
  }
  applyTheme();
}
