import { describe, expect, it } from "vitest";
import { lineEndingsNote } from "./lineEndings";

describe("line-ending-only changes", () => {
  it("names the line endings Git stores and the ones on disk", () => {
    expect(lineEndingsNote({ stored: "lf", working: "crlf" })).toBe("Only line endings changed: LF in Git, CRLF in the working copy. The text is the same.");
    expect(lineEndingsNote({ stored: "crlf", working: "mixed" })).toContain("CRLF in Git, mixed LF and CRLF in the working copy");
  });
});
