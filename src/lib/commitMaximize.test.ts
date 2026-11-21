import { describe, expect, it } from "vitest";
import { bindingFor, SHORTCUTS } from "./shortcuts";
import { toggleCommitMaximized, useUi } from "./ui";

describe("maximized commit details", () => {
  it("has a shortcut in Settings with no key until the user assigns one", () => {
    const def = SHORTCUTS.find(shortcut => shortcut.id === "commitMaximize");
    expect(def).toMatchObject({ label: "Maximize commit details", default: "" });
    expect(def?.scope).toBeUndefined();
    expect(bindingFor("commitMaximize", {})).toBe("");
    expect(bindingFor("commitMaximize", { commitMaximize: "Ctrl+Alt+M" })).toBe("Ctrl+Alt+M");
  });

  it("toggles on and back off", () => {
    useUi.setState({ commitMaximized: false });
    toggleCommitMaximized();
    expect(useUi.getState().commitMaximized).toBe(true);
    toggleCommitMaximized();
    expect(useUi.getState().commitMaximized).toBe(false);
    toggleCommitMaximized(false);
    expect(useUi.getState().commitMaximized).toBe(false);
  });
});
