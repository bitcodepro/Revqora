import { test } from "node:test";
import assert from "node:assert/strict";
import { repositoryRosterState } from "./repository-roster.mjs";

function inspect(rows, expected) {
  const before = globalThis.document;
  globalThis.document = { querySelectorAll: () => rows.map(([path,state="open",busy="false"]) => ({
    querySelector: () => ({ getAttribute: () => `${path}\nmain` }),
    getAttribute: key => key === "data-repository-state" ? state : busy,
  })) };
  try { return repositoryRosterState(expected); }
  finally { if (before === undefined) delete globalThis.document; else globalThis.document = before; }
}
test("twenty actual loaded repositories coexist with closed library bookmarks", () => {
  const roots = Array.from({length:20},(_,index)=>`D:/repos/repo-${index}`);
  const result = inspect([...roots.map(root=>[root]),["D:/previously-opened","closed"],["D:/another-bookmark","closed"]], roots);
  assert.equal(result.ready,true); assert.equal(result.openCount,20); assert.equal(result.rowCount,22);
  assert.deepEqual(result.closed,["D:/previously-opened","D:/another-bookmark"]);
});
test("a matching count cannot hide a missing expected repository or a duplicate", () => {
  const result = inspect([["D:/one"],["D:/one"]],["D:/one","D:/two"]);
  assert.equal(result.ready,false); assert.deepEqual(result.missing,["D:/two"]); assert.deepEqual(result.duplicates,["D:/one"]);
  const wrong = inspect([["D:/one"],["D:/wrong"]],["D:/one","D:/two"]);
  assert.equal(wrong.ready,false); assert.deepEqual(wrong.unexpected,["D:/wrong"]);
});
test("pending, failed and closed expected paths are not accepted as opened", () => {
  for (const [state,busy] of [["opening","true"],["open","true"],["unavailable","false"],["closed","false"]]) {
    assert.equal(inspect([["D:/one",state,busy]],["D:/one"]).ready,false);
  }
});
test("Windows slash, case and extended path spellings identify the same repository", () => {
  assert.equal(inspect([["\\\\?\\D:\\Repos\\One"]],["d:/repos/one/"]).ready,true);
  assert.equal(inspect([["/Repos/One"]],["/repos/one"]).ready,false);
});
