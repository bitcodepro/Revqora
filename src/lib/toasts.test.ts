import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUi } from "./ui";

describe("toasts", () => {
  beforeEach(() => { vi.useFakeTimers(); useUi.setState({ toasts: [] }); });
  afterEach(() => { vi.useRealTimers(); });

  it("keeps errors and toasts with an action long enough to read and use", () => {
    useUi.getState().toast({ kind: "info", title: "plain" });
    useUi.getState().toast({ kind: "error", title: "failed" });
    useUi.getState().toast({ kind: "success", title: "done", action: { label: "Undo", run: () => {} } });
    vi.advanceTimersByTime(5000);
    expect(useUi.getState().toasts.map(t => t.title)).toEqual(["failed", "done"]);
    vi.advanceTimersByTime(8000);
    expect(useUi.getState().toasts.map(t => t.title)).toEqual(["failed"]);
    vi.advanceTimersByTime(3000);
    expect(useUi.getState().toasts).toEqual([]);
  });

  it("does not dismiss a toast while it is hovered, then gives time to finish reading", () => {
    useUi.getState().toast({ kind: "info", title: "read me" });
    const id = useUi.getState().toasts[0].id;
    vi.advanceTimersByTime(3000);
    useUi.getState().holdToast(id, true);
    vi.advanceTimersByTime(60000);
    expect(useUi.getState().toasts).toHaveLength(1);
    useUi.getState().holdToast(id, false);
    vi.advanceTimersByTime(2400);
    expect(useUi.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(200);
    expect(useUi.getState().toasts).toEqual([]);
  });

  it("an expanded toast stays while the pointer and focus come and go", () => {
    useUi.getState().toast({ kind: "error", title: "push failed", detail: "long" });
    const id = useUi.getState().toasts[0].id;
    const hold = useUi.getState().holdToast;
    hold(id, true, "expanded");
    hold(id, true); hold(id, false);                     // hover Dismiss, move back to the text
    hold(id, true, "focus"); hold(id, false, "focus");   // Details button loses focus
    vi.advanceTimersByTime(10 * 60_000);
    expect(useUi.getState().toasts).toHaveLength(1);
    hold(id, false, "expanded");                         // collapse: the timer runs again
    vi.advanceTimersByTime(8000);
    expect(useUi.getState().toasts).toEqual([]);
  });
});
