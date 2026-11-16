/** A shortened result set must shrink its spacer even before the browser emits scroll. */
export function virtualRange(count: number, rowHeight: number, height: number, scroll: number, overscan = 5) {
  const top = Math.max(0, Math.min(scroll, Math.max(0, count * rowHeight - height)));
  return {
    start: Math.max(0, Math.floor(top / rowHeight) - overscan),
    end: Math.min(count, Math.ceil((top + height) / rowHeight) + overscan),
  };
}

/** Arrow, Home and End in a virtual list move focus from a focused row to the list itself: the
 *  row is removed once it scrolls out of the rendered range, and focus would fall to the page,
 *  where the next key press no longer reaches the list. */
export function holdListFocus(list: { contains(node: Element): boolean; focus(options?: FocusOptions): void }, active: Element | null) {
  if (active && active !== (list as unknown) && list.contains(active)) list.focus({ preventScroll: true });
}
