import { describe, expect, it } from "vitest";
import { installKeyboardFocus } from "./focusRing";

/** A document with just what the module uses: events and the root element's attributes. */
function fakeDocument() {
  const attributes = new Set<string>();
  const doc = Object.assign(new EventTarget(), {
    documentElement: { setAttribute: (name: string) => attributes.add(name), removeAttribute: (name: string) => attributes.delete(name) },
  });
  const key = (init: { key: string; altKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean }) => doc.dispatchEvent(Object.assign(new Event("keydown"), init));
  const pointer = () => doc.dispatchEvent(new Event("pointerdown"));
  return { doc: doc as unknown as Document, marked: () => attributes.has("data-keyboard-nav"), key, pointer };
}

describe("focus rings follow keyboard navigation only", () => {
  it("starts without rings: focus given back by a dialog or the window shows none", () => {
    const f = fakeDocument();
    installKeyboardFocus(f.doc);
    expect(f.marked()).toBe(false);
    f.key({ key: "Enter" });
    f.key({ key: "Escape" });
    f.key({ key: "Tab", altKey: true });
    f.key({ key: "Tab", ctrlKey: true });
    expect(f.marked()).toBe(false);
  });

  it("Tab turns rings on, a pointer press turns them off", () => {
    const f = fakeDocument();
    installKeyboardFocus(f.doc);
    f.key({ key: "Tab" });
    expect(f.marked()).toBe(true);
    f.key({ key: "Tab", shiftKey: true });
    expect(f.marked()).toBe(true);
    f.pointer();
    expect(f.marked()).toBe(false);
  });

  it("uninstalling removes the listeners and the mark", () => {
    const f = fakeDocument();
    const remove = installKeyboardFocus(f.doc);
    f.key({ key: "Tab" });
    remove();
    expect(f.marked()).toBe(false);
    f.key({ key: "Tab" });
    expect(f.marked()).toBe(false);
  });
});
