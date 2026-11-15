import { describe, expect, it } from "vitest";
import { addCoAuthor, coAuthorsIn, mergeRecentMessages, parsePerson, rememberMessage, removeCoAuthor, splitMessage } from "./commitTrailers";

const ada = { name: "Ada Example", email: "ada@example.com" };
const jo = { name: "Jö Ünicode", email: "jo@example.com" };

describe("co-author trailers", () => {
  it("validates the typed form", () => {
    expect(parsePerson("Ada Example <ada@example.com>")).toEqual(ada);
    expect(parsePerson("  Jö Ünicode<jo@example.com> ")).toEqual(jo);
    expect(parsePerson("ada@example.com")).toBeNull();
    expect(parsePerson("Ada <not-an-email>")).toBeNull();
    expect(parsePerson("<ada@example.com>")).toBeNull();
    expect(parsePerson("Ada <a b@example.com>")).toBeNull();
  });

  it("adds once at the end after a blank line", () => {
    expect(addCoAuthor("", ada)).toBe("Co-authored-by: Ada Example <ada@example.com>");
    const once = addCoAuthor("Explain why.\n", ada);
    expect(once).toBe("Explain why.\n\nCo-authored-by: Ada Example <ada@example.com>");
    expect(addCoAuthor(once, { ...ada, email: "ADA@example.com" })).toBe(once);
  });

  it("joins an existing trailer block and keeps other trailers", () => {
    const body = "Explain.\n\nSigned-off-by: Ada Example <ada@example.com>";
    expect(addCoAuthor(body, jo)).toBe(`${body}\nCo-authored-by: Jö Ünicode <jo@example.com>`);
    const both = addCoAuthor(addCoAuthor(body, jo), ada);
    expect(coAuthorsIn(both)).toEqual([jo, ada]);
    expect(removeCoAuthor(both, "JO@example.com")).toBe(`${body}\nCo-authored-by: Ada Example <ada@example.com>`);
  });

  it("removing the only trailer leaves the text without trailing blank lines", () => {
    expect(removeCoAuthor(addCoAuthor("Explain.", ada), ada.email)).toBe("Explain.");
    expect(removeCoAuthor("Co-authored-by: Ada Example <ada@example.com>", ada.email)).toBe("");
  });

  it("parses trailers typed by hand", () => {
    expect(coAuthorsIn("x\n\nco-authored-by:  Ada Example  <ada@example.com>\nCo-authored-by: Ada Example <ada@example.com>")).toEqual([ada]);
  });
});

describe("recent messages", () => {
  it("de-duplicates, newest first, with a limit", () => {
    let list: string[] = [];
    list = rememberMessage(list, "First");
    list = rememberMessage(list, "Second\n\nbody");
    list = rememberMessage(list, "First\r\n");
    expect(list).toEqual(["First", "Second\n\nbody"]);
    expect(rememberMessage(list, "   ")).toEqual(list);
    expect(rememberMessage(["a", "b", "c"], "d", 3)).toEqual(["d", "a", "b"]);
  });

  it("merges local and history messages without duplicates", () => {
    expect(mergeRecentMessages(["Fix bug", "Add x"], ["Add x\n", "Older", "", "Fix bug"], 30)).toEqual(["Fix bug", "Add x", "Older"]);
    expect(mergeRecentMessages(["a"], ["b", "c"], 2)).toEqual(["a", "b"]);
  });

  it("splits summary and body", () => {
    expect(splitMessage("Subject\n\nBody line\n")).toEqual({ summary: "Subject", body: "Body line" });
  });
});
