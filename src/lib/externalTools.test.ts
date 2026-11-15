import { describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({ api: {} }));
vi.mock("./settings", () => ({ useSettings: { getState: () => ({}) } }));
vi.mock("./ui", () => ({ toast: {} }));
vi.mock("./store", () => ({ useRepos: { getState: () => ({}) } }));
import { EDITOR_PRESETS, editorPresetLabel } from "./externalTools";

describe("editor presets", () => {
  it("names the preset a command matches and calls anything else custom", () => {
    expect(editorPresetLabel("")).toBe("System text editor");
    expect(editorPresetLabel("  code --goto {file}:{line}:{column} ")).toBe("Visual Studio Code");
    expect(editorPresetLabel("myeditor {file}")).toBe("Custom");
  });
  it("every preset passes the file and has a unique name", () => {
    for (const p of EDITOR_PRESETS.slice(1)) expect(p.command).toContain("{file}");
    expect(new Set(EDITOR_PRESETS.map((p) => p.label)).size).toBe(EDITOR_PRESETS.length);
  });
});
