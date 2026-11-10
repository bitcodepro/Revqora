const windows = new Set<Window>();

export function surfaceDocument(view: Window): Document | null {
  try { return view.closed ? null : view.document; } catch { return null; }
}

export function registerUiSurface(view: Window) {
  windows.add(view);
  return () => { windows.delete(view); };
}

export function focusedUiSurface(): Window {
  for (const view of windows) {
    if (surfaceDocument(view)?.hasFocus()) return view;
  }
  return window;
}
