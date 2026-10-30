import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { removeTestTmp, SafeCleanupError } from "../scripts/safe-test-tmp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", ".test-tmp");
let seq = 0;
mkdirSync(ROOT, { recursive: true });

function repo() {
  const root = join(ROOT, `safe-clean-${process.pid}-${Date.now()}-${seq++}`);
  mkdirSync(root, { recursive: true });
  return root;
}
function cleanup(root) {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
function code(fn) {
  try { fn(); assert.fail("expected SafeCleanupError"); }
  catch (error) {
    assert.ok(error instanceof SafeCleanupError, String(error));
    return error.code;
  }
}

test("only the canonical repo .test-tmp directory is removed", () => {
  const root = repo();
  try {
    mkdirSync(join(root, ".test-tmp"));
    writeFileSync(join(root, ".test-tmp", "synthetic.txt"), "synthetic");
    assert.equal(removeTestTmp(root), true);
    assert.equal(existsSync(join(root, ".test-tmp")), false);
    assert.equal(removeTestTmp(root), false);
  } finally { cleanup(root); }
});

test("a .test-tmp junction/symlink is refused and its target is untouched", (t) => {
  const root = repo();
  const outside = join(ROOT, `safe-clean-outside-${process.pid}-${Date.now()}`);
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "sentinel.txt"), "must survive");
  try {
    try {
      symlinkSync(outside, join(root, ".test-tmp"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      t.skip(`filesystem cannot create alias: ${error.code ?? error.message}`);
      return;
    }
    assert.equal(existsSync(join(outside, "sentinel.txt")), true);
    const result = (() => {
      try { removeTestTmp(root); return "OK"; }
      catch (error) { return error.code; }
    })();
    assert.ok(result === "QA_CLEAN_ALIAS" || result === "QA_CLEAN_OUTSIDE", result);
    assert.equal(existsSync(join(outside, "sentinel.txt")), true, "target must be untouched");
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});

test("a junction inside .test-tmp is unlinked without deleting its target", (t) => {
  const root = repo();
  const outside = join(ROOT, `safe-clean-nested-outside-${process.pid}-${Date.now()}`);
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "sentinel.txt"), "must survive");
  try {
    const target = join(root, ".test-tmp");
    mkdirSync(target);
    try {
      symlinkSync(outside, join(target, "nested-alias"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      t.skip(`filesystem cannot create alias: ${error.code ?? error.message}`);
      return;
    }
    assert.equal(removeTestTmp(root), true);
    assert.equal(existsSync(target), false);
    assert.equal(existsSync(join(outside, "sentinel.txt")), true);
  } finally {
    cleanup(root);
    cleanup(outside);
  }
});
