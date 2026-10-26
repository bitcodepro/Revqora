import { describe, expect, it } from "vitest";
import { restoreWorkspaceLayouts } from "./workspaceLayouts";

describe("workspace layout persistence", () => {
  it("migrates the shared legacy layout into independent mode profiles", () => {
    const layouts = restoreWorkspaceLayouts({ sidebarWidth: 310, repositoriesOpen: false, commitFilesWidth: 275 });
    expect(layouts.graph).toMatchObject({ sidebarWidth: 310, repositoriesOpen: false, commitFilesWidth: 275 });
    expect(layouts.columns).toMatchObject({ sidebarWidth: 310, repositoriesOpen: false, historyListWidth: 300 });
    layouts.columns.branchesOpen = false;
    layouts.columns.commitFilesWidth = 400;
    expect(layouts.review.branchesOpen).toBe(true);
    expect(layouts.graph.commitFilesWidth).toBe(275);
  });
  it("restores partial saved modes and supplies defaults without copying invalid widths", () => {
    const layouts = restoreWorkspaceLayouts({ layouts: { columns: { historyListWidth: 390, focusMode: true }, review: { branchesOpen: false, commitFilesWidth: -20 } } });
    expect(layouts.columns).toMatchObject({ historyListWidth: 390, focusMode: true, commitFilesWidth: 240 });
    expect(layouts.review).toMatchObject({ branchesOpen: false, commitFilesWidth: 240, focusMode: false });
    expect(layouts.graph.repositoriesWidth).toBe(224);
  });
});
