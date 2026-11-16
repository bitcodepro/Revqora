import { describe, expect, it } from "vitest";
import { reconcileAmend, type CommitDraft } from "./amendDraft";

const loaded = { summary: "Fix parser", body: "Handles empty input." };

describe("amend draft", () => {
  it("survives refreshes and status changes while HEAD is the commit being amended", () => {
    const draft: CommitDraft = { ...loaded, amend: true, amendHead: "aaa", amendMessage: loaded };
    expect(reconcileAmend(draft, "aaa")).toBe(draft);
    // HEAD is unknown while the repository information reloads.
    expect(reconcileAmend(draft, null)).toBe(draft);
    expect(reconcileAmend(draft, undefined)).toBe(draft);
  });

  it("turns off and withdraws the loaded message when HEAD becomes another commit", () => {
    const draft: CommitDraft = { ...loaded, amend: true, amendHead: "aaa", amendMessage: loaded };
    expect(reconcileAmend(draft, "bbb")).toEqual({ summary: "", body: "", amend: false, amendHead: null, amendMessage: null });
  });

  it("keeps text the user typed or edited when Amend turns off", () => {
    const edited: CommitDraft = { summary: "Fix parser and lexer", body: loaded.body, amend: true, amendHead: "aaa", amendMessage: loaded };
    expect(reconcileAmend(edited, "bbb")).toMatchObject({ summary: "Fix parser and lexer", body: loaded.body, amend: false });
    const typed: CommitDraft = { summary: "Reword", body: "", amend: true, amendHead: "aaa", amendMessage: null };
    expect(reconcileAmend(typed, "bbb")).toMatchObject({ summary: "Reword", body: "", amend: false });
  });

  it("leaves a draft without Amend alone, whatever HEAD is", () => {
    const draft: CommitDraft = { summary: "New work", body: "" };
    expect(reconcileAmend(draft, "bbb")).toBe(draft);
    const off: CommitDraft = { summary: "New work", body: "", amend: false, amendHead: "aaa" };
    expect(reconcileAmend(off, "bbb")).toBe(off);
  });

  it("adopts the first known HEAD when Amend was turned on before it loaded", () => {
    const draft: CommitDraft = { summary: "", body: "", amend: true, amendHead: null };
    const adopted = reconcileAmend(draft, "aaa");
    expect(adopted).toMatchObject({ amend: true, amendHead: "aaa" });
    expect(reconcileAmend(adopted, "aaa")).toBe(adopted);
    expect(reconcileAmend(adopted, "bbb").amend).toBe(false);
  });
});
