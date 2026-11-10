import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fillWorktreeFolder, reviewWorktreeCreation } from "./worktree-manager-fixture.mjs";

test("the palette waits for the enabled suggestion for the selected branch before writing the Windows path", async () => {
  const root = "D:\\fixture root\\démo";
  const destination = "D:\\fixture root\\palette worktree ü";
  const calls = [];
  let release;
  const loaded = new Promise(resolve => { release = resolve; });
  let value = "", branch = "", enabled = false;
  const dialog = {
    getByRole: (role, options) => {
      assert.equal(role, "textbox");
      assert.deepEqual(options, { name: "Worktree folder", exact: true });
      return {
        fill: async expected => { calls.push(["fill", expected]); value = expected; },
        inputValue: async () => { calls.push(["read"]); return value; },
      };
    },
  };
  const page = {
    waitForFunction: async (predicate, args) => {
      calls.push(["wait"]);
      const previous = globalThis.document;
      globalThis.document = {
        querySelector: selector => selector.startsWith("select")
          ? { value: branch }
          : { value, matches: state => state === ":enabled" && enabled },
      };
      try {
        assert.equal(predicate(args), false);
        await loaded;
        branch = "feature/topic";
        value = "D:\\fixture root/démo-feature-topic";
        assert.equal(predicate(args), false, "the correct suggestion is not yet editable");
        enabled = true;
        value = "D:\\fixture root/démo-old";
        assert.equal(predicate(args), false, "the previous branch suggestion is still displayed");
        value = "D:\\fixture root/démo-feature-topic";
        assert.equal(predicate(args), true);
      } finally {
        globalThis.document = previous;
      }
    },
  };

  const filling = fillWorktreeFolder(page, dialog, root, destination);
  assert.deepEqual(calls, [["wait"]]);
  release();
  await filling;
  assert.deepEqual(calls, [["wait"], ["fill", destination], ["read"]]);
});

test("concatenated or redirected worktree input fails before the caller can request a review", async () => {
  for (const actual of ["D:/suggestedD:/chosen", "D:/other", ""]) {
    const dialog = {
      getByRole: () => ({ fill: async () => {}, inputValue: async () => actual }),
      evaluate: async () => ({ folder: actual, branch: "feature/topic", message: null }),
    };
    await assert.rejects(
      fillWorktreeFolder({ waitForFunction: async () => {} }, dialog, "D:/demo", "D:/chosen"),
      /Worktree folder mismatch before review.*feature\/topic/,
    );
  }
});

test("missing autofill reports the form without typing or requesting a review", async () => {
  const failure = new Error("suggested folder never appeared");
  let fills = 0;
  const dialog = {
    getByRole: () => ({ fill: async () => fills++ }),
    evaluate: async () => ({ folder: "", branch: "feature/topic", message: "Cannot read branches" }),
  };
  await assert.rejects(
    fillWorktreeFolder({ waitForFunction: async () => { throw failure; } }, dialog, "D:/demo", "D:/chosen"),
    error => error.cause === failure && error.message.includes("Cannot read branches"),
  );
  assert.equal(fills, 0);
});

test("review requires the exact form value and reviewed destination and reports a visible rejection", async () => {
  const destination = path.join(fs.realpathSync.native(process.cwd()), "review worktree ü");
  let fieldValue = destination, reviewedPath = destination, message = "", clicks = 0;
  const alert = { isVisible: async () => !!message, innerText: async () => message };
  const review = {
    or: other => {
      assert.equal(other, alert);
      return { first: () => ({ waitFor: async () => {} }) };
    },
    locator: () => ({ first: () => ({ innerText: async () => reviewedPath }) }),
  };
  const dialog = {
    getByRole: role => {
      if (role === "alert") return alert;
      if (role === "textbox") return { inputValue: async () => fieldValue };
      return { click: async () => clicks++ };
    },
    locator: () => review,
    evaluate: async () => ({ folder: fieldValue, branch: "feature/topic", message }),
  };

  fieldValue += destination;
  await assert.rejects(reviewWorktreeCreation(dialog, destination), /Worktree folder mismatch before review/);
  assert.equal(clicks, 0);

  fieldValue = destination;
  assert.equal(await reviewWorktreeCreation(dialog, destination), review);
  reviewedPath += " other";
  await assert.rejects(reviewWorktreeCreation(dialog, destination), /Reviewed destination mismatch/);

  message = "Invalid folder (os error 123)";
  await assert.rejects(reviewWorktreeCreation(dialog, destination), /os error 123.*feature\/topic/);
});
