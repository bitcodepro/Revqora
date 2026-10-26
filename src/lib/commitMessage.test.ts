import { describe, expect, it } from "vitest";
import { splitCommitMessage } from "./commitMessage";

describe("commit message trailers", () => {
  it("separates terminal sign-offs while preserving paragraphs and other trailer values", () => {
    const description = "Long explanation.\n\n\n- Keep file selection\n- Keep scroll";
    expect(splitCommitMessage(description + "\n\nCo-authored-by: Jane <jane@example.com>\nSigned-off-by: John\nFixes: #42")).toEqual({
      description,
      trailers: [{ key: "Co-authored-by", value: "Jane <jane@example.com>" }, { key: "Signed-off-by", value: "John" }, { key: "Fixes", value: "#42" }],
    });
  });
  it("handles trailer-only messages, CRLF and folded values", () => {
    expect(splitCommitMessage("Reviewed-by: A\r\n  and B\r\n")).toEqual({ description: "", trailers: [{ key: "Reviewed-by", value: "A\nand B" }] });
    expect(splitCommitMessage("")).toEqual({ description: "", trailers: [] });
  });
  it("keeps ambiguous prose and code intact", () => {
    for (const description of [
      "Reason: preserve context", "Co-authored-by: A\nThis is still prose.",
      "Co-authored-by: A\n\nMore explanation follows.",
      "Example:\n\n```text\n\nCo-authored-by: A", "```\nCo-authored-by: A\n```",
    ]) expect(splitCommitMessage(description)).toEqual({ description, trailers: [] });
  });
});
