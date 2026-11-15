/** Focus to restore when a context menu closes: the element that opened it, if it still exists
 *  and focus did not already move somewhere real (into another control the user picked). */
export function menuFocusTarget(opener: HTMLElement | null, active: Element | null, body: Element): HTMLElement | null {
  if (!opener || opener === body || !opener.isConnected) return null;
  const lost = !active || active === body || !active.isConnected || !!active.closest(".ctx-menu");
  return lost ? opener : null;
}

/** The commit a Down/Up press moves to in a history list, from the live selection. */
export function steppedOid(items: { oid: string }[], current: string | null, step: number): string | null {
  if (!items.length) return null;
  const at = items.findIndex((it) => it.oid === current);
  return items[Math.min(items.length - 1, Math.max(0, at + step))].oid;
}

/** A row inside `list` itself, so a dialog in a detached window never finds the main window's row. */
export function rowIn(list: ParentNode | null, oid: string): HTMLElement | null {
  return list?.querySelector<HTMLElement>(`[data-oid="${oid}"]`) ?? null;
}
