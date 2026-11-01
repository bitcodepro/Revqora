import { afterEach, describe, expect, it, vi } from "vitest";
import { scheduleDialogFocus } from "./dialogFocus";

describe("initial dialog focus", () => {
  afterEach(() => vi.useRealTimers());
  function fixture() {
    const document = { activeElement: {} };
    const first = { tagName: "INPUT", focus: vi.fn(), select: vi.fn() };
    const fields = new Set<unknown>([first]);
    const dialog = { ownerDocument: document, contains: (el: unknown) => fields.has(el), querySelector: vi.fn(() => first) };
    return { document, first, fields, dialog: dialog as unknown as HTMLElement };
  }
  it("preserves a second field focused while the initial timer was pending", () => {
    vi.useFakeTimers(); const f = fixture();
    scheduleDialogFocus(() => f.dialog);
    const executable = { value: "node.exe" }; f.fields.add(executable); f.document.activeElement = executable;
    vi.advanceTimersByTime(30);
    expect(f.first.focus).not.toHaveBeenCalled(); expect(f.first.select).not.toHaveBeenCalled();
    expect(f.document.activeElement).toBe(executable); expect(executable.value).toBe("node.exe");
  });
  it("sets initial keyboard focus when it is still outside the dialog", () => {
    vi.useFakeTimers(); const f = fixture(); scheduleDialogFocus(() => f.dialog);
    vi.advanceTimersByTime(30); expect(f.first.focus).toHaveBeenCalledOnce(); expect(f.first.select).toHaveBeenCalledOnce();
  });
  it("cancels the initial timer on unmount, including StrictMode effect cleanup", () => {
    vi.useFakeTimers(); const f = fixture(); const cancel = scheduleDialogFocus(() => f.dialog); cancel();
    vi.advanceTimersByTime(30); expect(f.first.focus).not.toHaveBeenCalled();
    scheduleDialogFocus(() => f.dialog); vi.advanceTimersByTime(30); expect(f.first.focus).toHaveBeenCalledOnce();
  });
});
