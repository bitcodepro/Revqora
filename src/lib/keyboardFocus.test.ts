import { describe, expect, it, vi } from "vitest";
import { menuFocusTarget, rowIn, steppedOid } from "./keyboardFocus";
import { useUi } from "./ui";

const element = (connected = true, inMenu = false) => ({ isConnected: connected, closest: (s: string) => (inMenu && s === ".ctx-menu" ? {} : null) }) as unknown as HTMLElement;

describe("context menu focus", () => {
  it("records the opener before the menu takes focus, and keeps it for submenus", () => {
    const opener = element();
    const surface = { document: { activeElement: opener } } as unknown as Window;
    useUi.setState({ menu: null });
    useUi.getState().openMenu(1, 2, [], surface);
    expect(useUi.getState().menu?.opener).toBe(opener);
    (surface.document as { activeElement: unknown }).activeElement = element(true, true);
    useUi.getState().openMenu(3, 4, [], surface);
    expect(useUi.getState().menu?.opener).toBe(opener);
    useUi.getState().closeMenu();
  });

  it("returns focus to the opener after Escape or Tab removed the focused item", () => {
    const body = element(), opener = element();
    expect(menuFocusTarget(opener, element(false, true), body)).toBe(opener);
    expect(menuFocusTarget(opener, body, body)).toBe(opener);
    expect(menuFocusTarget(opener, null, body)).toBe(opener);
  });

  it("leaves focus alone when an action moved it on, or the opener is gone", () => {
    const body = element(), opener = element();
    expect(menuFocusTarget(opener, element(), body)).toBeNull();
    expect(menuFocusTarget(element(false), body, body)).toBeNull();
    expect(menuFocusTarget(body, body, body)).toBeNull();
  });
});

describe("file history keyboard navigation", () => {
  const items = [{ oid: "a" }, { oid: "b" }, { oid: "c" }];
  it("steps from the live selection and stops at the ends", () => {
    expect(steppedOid(items, "a", 1)).toBe("b");
    expect(steppedOid(items, "b", 1)).toBe("c");
    expect(steppedOid(items, "c", 1)).toBe("c");
    expect(steppedOid(items, "a", -1)).toBe("a");
    expect(steppedOid([], "a", 1)).toBeNull();
  });

  it("finds rows only inside its own list (a detached window's document)", () => {
    const row = element();
    const list = { querySelector: vi.fn(() => row) };
    expect(rowIn(list as unknown as ParentNode, "b")).toBe(row);
    expect(list.querySelector).toHaveBeenCalledWith('[data-oid="b"]');
    expect(rowIn(null, "b")).toBeNull();
  });
});
