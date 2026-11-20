import { describe, expect, it } from "vitest";
import { scanCounts } from "../components/RepositoryFolderImport";

describe("folder scan progress", () => {
  it("counts folders checked and repositories found", () => {
    expect(scanCounts({ folders: 1, repositories: 0 })).toBe("1 folder checked · 0 repositories found");
    expect(scanCounts({ folders: 12345, repositories: 1 })).toBe("12,345 folders checked · 1 repository found");
  });
});
