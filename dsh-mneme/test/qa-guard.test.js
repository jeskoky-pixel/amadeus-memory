import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertIsolatedMemoryDir,
  knownForbiddenMemoryDirs,
  QaGuardError
} from "../src/qa-guard.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", ".test-tmp");
let seq = 0;

function setup() {
  mkdirSync(ROOT, { recursive: true });
  const qaRoot = join(ROOT, `guard-${process.pid}-${Date.now()}-${seq++}`);
  mkdirSync(qaRoot, { recursive: true });
  return qaRoot;
}
function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
function code(fn) {
  try { fn(); assert.fail("expected QaGuardError"); }
  catch (error) {
    assert.ok(error instanceof QaGuardError, String(error));
    return error.code;
  }
}

test("allowed nested isolated memoryDir is canonicalized under the QA root", () => {
  const root = setup();
  try {
    const target = join(root, "nested", "memory");
    const resolved = assertIsolatedMemoryDir(target, { qaRoot: root });
    assert.equal(existsSync(resolved), true);
    assert.equal(resolved.toLowerCase(), target.toLowerCase());
    // Case aliases are the same identity on Windows; the guard must accept it.
    if (process.platform === "win32") {
      assert.equal(assertIsolatedMemoryDir(target.toUpperCase(), { qaRoot: root }).toLowerCase(), target.toLowerCase());
    }
  } finally { cleanup(root); }
});

test("default is derived from homedir and synthetic private roots fail before creation", () => {
  const root = setup();
  const synthetic = join(ROOT, `guard-synthetic-user-memory-${process.pid}-${Date.now()}`);
  mkdirSync(synthetic, { recursive: true });
  try {
    const derivedDefault = knownForbiddenMemoryDirs()[0];
    assert.equal(derivedDefault, resolve(join(homedir(), ".dsh", "memory")),
      "the only built-in user path must come from homedir");
    const target = join(synthetic, "must-not-create");
    assert.equal(
      code(() => assertIsolatedMemoryDir(target, { qaRoot: root, forbiddenDirs: [synthetic] })),
      "QA_PATH_IS_USER_MEMORY"
    );
    assert.equal(existsSync(target), false, "guard must not create a rejected private root");
  } finally {
    cleanup(root);
    cleanup(synthetic);
  }
});

test("traversal, missing QA root and non-directory target fail closed", () => {
  const root = setup();
  try {
    assert.equal(code(() => assertIsolatedMemoryDir(join(root, "..", "outside"), { qaRoot: root })), "QA_PATH_OUTSIDE_ROOT");
    assert.equal(code(() => assertIsolatedMemoryDir(join(root, "child"), { qaRoot: join(root, "missing") })), "QA_ROOT_UNRESOLVED");
    const file = join(root, "file");
    writeFileSync(file, "not a directory");
    assert.equal(code(() => assertIsolatedMemoryDir(file, { qaRoot: root })), "QA_PATH_NOT_DIRECTORY");
  } finally { cleanup(root); }
});

test("a junction/symlink alias to a custom user directory is rejected without writing through it", (t) => {
  const root = setup();
  const forbidden = join(ROOT, `guard-forbidden-${process.pid}-${Date.now()}`);
  mkdirSync(forbidden, { recursive: true });
  const link = join(root, "alias");
  try {
    try {
      symlinkSync(forbidden, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      t.skip(`this filesystem cannot create a directory alias: ${error.code ?? error.message}`);
      return;
    }
    assert.equal(
      code(() => assertIsolatedMemoryDir(join(link, "nested"), { qaRoot: root, forbiddenDirs: [forbidden] })),
      "QA_PATH_IS_USER_MEMORY"
    );
    assert.equal(existsSync(join(forbidden, "nested")), false, "must reject before writing through alias");
  } finally {
    cleanup(root);
    cleanup(forbidden);
  }
});
