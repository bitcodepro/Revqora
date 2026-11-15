import { afterEach, describe, expect, it, vi } from "vitest";
import { focusReturnTarget, scheduleDialogFocus, trappedTabTarget } from "./dialogFocus";

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
  it("focuses Cancel when a danger confirmation has no input or primary button", () => {
    vi.useFakeTimers(); const f=fixture();
    const cancel={tagName:"BUTTON",focus:vi.fn()};
    vi.mocked(f.dialog.querySelector).mockReturnValueOnce(null).mockReturnValueOnce(cancel as unknown as HTMLElement);
    scheduleDialogFocus(()=>f.dialog);vi.advanceTimersByTime(30);
    expect(cancel.focus).toHaveBeenCalledOnce();
  });
  it("for agent requests focuses the dialog itself, never a field or the approve button", () => {
    vi.useFakeTimers(); const f = fixture();
    const focusDialog = vi.fn(); (f.dialog as unknown as { focus: () => void }).focus = focusDialog;
    scheduleDialogFocus(() => f.dialog, "dialog"); vi.advanceTimersByTime(30);
    expect(focusDialog).toHaveBeenCalledOnce();
    expect(f.first.focus).not.toHaveBeenCalled(); expect(f.first.select).not.toHaveBeenCalled();
  });
});

describe("dialog focus trap", () => {
  const dialog = { name: "dialog" }, first = { name: "first" }, middle = { name: "middle" }, last = { name: "last" };
  const items = [first, middle, last];
  it("wraps Tab from the last control to the first and Shift+Tab from the first to the last", () => {
    expect(trappedTabTarget(items, last, dialog, false)).toBe(first);
    expect(trappedTabTarget(items, first, dialog, true)).toBe(last);
    // Focus on the dialog itself (an agent request) steps backwards into it, not behind it.
    expect(trappedTabTarget(items, dialog, dialog, true)).toBe(last);
  });
  it("leaves steps that stay inside the dialog to the browser", () => {
    expect(trappedTabTarget(items, first, dialog, false)).toBeNull();
    expect(trappedTabTarget(items, middle, dialog, false)).toBeNull();
    expect(trappedTabTarget(items, middle, dialog, true)).toBeNull();
    expect(trappedTabTarget(items, last, dialog, true)).toBeNull();
  });
  it("keeps Tab on the only field (the command palette) and on a dialog without controls", () => {
    expect(trappedTabTarget([first], first, dialog, false)).toBe(first);
    expect(trappedTabTarget([first], first, dialog, true)).toBe(first);
    expect(trappedTabTarget([], dialog, dialog, false)).toBe(dialog);
    expect(trappedTabTarget([], dialog, dialog, true)).toBe(dialog);
  });
});

describe("focus after a dialog closes", () => {
  const element = (connected = true, inert = false) => ({ isConnected: connected, closest: (s: string) => (inert && s === "[inert]" ? {} : null) }) as unknown as HTMLElement;
  const dialogWith = (...inside: unknown[]) => ({ contains: (node: Element) => inside.includes(node) });
  it("returns to the opener when focus stayed in the closing dialog or was lost", () => {
    const body = element(), opener = element(), field = element();
    expect(focusReturnTarget(opener, field, body, dialogWith(field))).toBe(opener);
    expect(focusReturnTarget(opener, body, body, dialogWith())).toBe(opener);
    expect(focusReturnTarget(opener, null, body, dialogWith())).toBe(opener);
    expect(focusReturnTarget(opener, element(false), body, dialogWith())).toBe(opener);
  });
  it("keeps focus where a command placed it", () => {
    const body = element(), opener = element(), search = element();
    expect(focusReturnTarget(opener, search, body, dialogWith())).toBeNull();
  });
  it("has nowhere to return when the opener is gone, hidden behind a dialog, or was the page", () => {
    const body = element(), field = element();
    expect(focusReturnTarget(element(false), field, body, dialogWith(field))).toBeNull();
    expect(focusReturnTarget(element(true, true), field, body, dialogWith(field))).toBeNull();
    expect(focusReturnTarget(body, field, body, dialogWith(field))).toBeNull();
    expect(focusReturnTarget(null, field, body, dialogWith(field))).toBeNull();
  });
});
