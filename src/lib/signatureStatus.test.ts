import { describe, expect, it, vi } from "vitest";
vi.mock("./api", () => ({ api: { signatureStatus: vi.fn() } }));
import { signatureBadge } from "./signatureStatus";

describe("signature badges", () => {
  it("shows a badge only for signed commits, with a tone by result", () => {
    expect(signatureBadge("N")).toBeNull();
    expect(signatureBadge("")).toBeNull();
    expect(signatureBadge("G")?.tone).toBe("good");
    expect(signatureBadge("U")?.tone).toBe("warn");
    expect(signatureBadge("B")?.tone).toBe("bad");
    expect(signatureBadge("R")?.tone).toBe("bad");
  });
});
