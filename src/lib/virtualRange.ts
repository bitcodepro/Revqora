/** A shortened result set must shrink its spacer even before the browser emits scroll. */
export function virtualRange(count: number, rowHeight: number, height: number, scroll: number, overscan = 5) {
  const top = Math.max(0, Math.min(scroll, Math.max(0, count * rowHeight - height)));
  return {
    start: Math.max(0, Math.floor(top / rowHeight) - overscan),
    end: Math.min(count, Math.ceil((top + height) / rowHeight) + overscan),
  };
}
