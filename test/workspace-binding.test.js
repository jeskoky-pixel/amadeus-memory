import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  WORKSPACE_BINDING_FILE,
  WORKSPACE_BINDING_VERSION,
  WORKSPACE_DATA_ROOT,
  WORKSPACE_MARKER_FILE,
  WORKSPACE_MARKER_VERSION,
  initializeWorkspaceDataDir,
  readWorkspaceBinding,
  resolveWorkspaceDataDir,
  setWorkspaceBinding,
  unbindWorkspace,
  workspaceBindingPath,
  workspaceDataDirFor,
  workspaceDataRoot
} from "../src/workspace-binding.js";

const tempDirs = [];

function tempMemoryDir() {
  const dir = mkdtempSync(join(tmpdir(), "mneme-workspace-binding-"));
  tempDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function workspace(id, title = "Project") {
  return {
    id,
    title,
    sessionIds: ["session-1"],
    directory: "C:\\private\\workspace-path",
    preset: "private-preset"
  };
}

function ctxOf(...workspaces) {
  return { workspaceRegistry: { list: () => workspaces } };
}

function digestOf(id) {
  return createHash("sha256").update(id, "utf8").digest("hex");
}

function bindingPath(dir) {
  return join(dir, WORKSPACE_BINDING_FILE);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function tempEntries(dir) {
  return readdirSync(dir).filter((name) => name.includes(".tmp-"));
}

function assertUnbound(result, diagnostic = null) {
  assert.deepEqual(result, {
    bound: false,
    workspaceId: null,
    diagnostic,
    reason: "unbound"
  });
}

function assertPathInside(dir, path) {
  const root = workspaceDataRoot(dir);
  const rel = relative(root, path);
  assert.ok(rel && !rel.startsWith("..") && !rel.includes(".."), `${path} must stay inside ${root}`);
}

test("workspace-binding: absent file is unbound and creates nothing", () => {
  const missing = join(tempMemoryDir(), "not-created");
  assertUnbound(readWorkspaceBinding(missing));
  assert.equal(existsSync(missing), false, "read must not create memoryDir");

  const resolved = resolveWorkspaceDataDir(missing);
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, "unbound");
  assert.equal(resolved.workspaceId, null);
  assert.equal(resolved.path, null);
  assert.equal(existsSync(missing), false, "read-only resolution must not create anything");

  const initialized = initializeWorkspaceDataDir(missing);
  assert.equal(initialized.ok, false);
  assert.equal(initialized.reason, "unbound");
  assert.equal(existsSync(missing), false, "unbound initialization must create nothing");
});

test("workspace-binding: corrupt and unsupported data read as unbound with a diagnostic", () => {
  const dir = tempMemoryDir();
  const file = bindingPath(dir);

  writeFileSync(file, "{not json", "utf8");
  assertUnbound(readWorkspaceBinding(dir), "binding-corrupt");
  assert.equal(resolveWorkspaceDataDir(dir).reason, "unbound");
  assert.equal(initializeWorkspaceDataDir(dir).reason, "unbound");

  writeFileSync(file, JSON.stringify(["ws-a"]), "utf8");
  assertUnbound(readWorkspaceBinding(dir), "binding-corrupt");

  writeFileSync(file, JSON.stringify({ version: 99, workspaceId: "ws-a" }), "utf8");
  assertUnbound(readWorkspaceBinding(dir), "binding-unsupported-version");

  writeFileSync(file, JSON.stringify({ version: WORKSPACE_BINDING_VERSION }), "utf8");
  assertUnbound(readWorkspaceBinding(dir), "binding-missing-workspace-id");

  writeFileSync(file, JSON.stringify({ version: WORKSPACE_BINDING_VERSION, workspaceId: 7 }), "utf8");
  assertUnbound(readWorkspaceBinding(dir), "binding-missing-workspace-id");

  // Corrupt data must never be interpreted as all-workspaces.
  assert.equal(readWorkspaceBinding(dir).workspaceId, null);
});

test("workspace-binding: valid selection persists one exact ID and stores no extra metadata", () => {
  const dir = tempMemoryDir();
  const ctx = ctxOf(workspace("ws-a", "Project"));

  const selected = setWorkspaceBinding({ memoryDir: dir, workspaceId: "ws-a", ctx });
  assert.deepEqual(selected, {
    ok: true,
    changed: true,
    oldWorkspaceId: null,
    newWorkspaceId: "ws-a",
    requestedWorkspaceId: "ws-a",
    reason: "selected",
    diagnostic: null
  });

  assert.deepEqual(readJson(bindingPath(dir)), {
    version: WORKSPACE_BINDING_VERSION,
    workspaceId: "ws-a"
  });
  assert.deepEqual(readWorkspaceBinding(dir), {
    bound: true,
    workspaceId: "ws-a",
    diagnostic: null,
    reason: "ok"
  });

  const again = setWorkspaceBinding({ memoryDir: dir, workspaceId: "ws-a", ctx });
  assert.equal(again.ok, true);
  assert.equal(again.changed, false);
  assert.equal(again.reason, "unchanged");
  assert.equal(again.oldWorkspaceId, "ws-a");
  assert.equal(again.newWorkspaceId, "ws-a");

  // Resolution is read-only: the data directory is not created by selection or
  // by resolution; only explicit initialization creates it.
  const beforeInit = resolveWorkspaceDataDir(dir);
  assert.equal(beforeInit.ok, true);
  assert.equal(beforeInit.reason, "absent");
  assert.equal(beforeInit.initialized, false);
  assert.equal(beforeInit.path, join(dir, WORKSPACE_DATA_ROOT, digestOf("ws-a")));
  assertPathInside(dir, beforeInit.path);
  assert.equal(existsSync(beforeInit.path), false);

  const initialized = initializeWorkspaceDataDir(dir);
  assert.deepEqual(initialized, {
    ok: true,
    workspaceId: "ws-a",
    path: beforeInit.path,
    exists: true,
    created: true,
    initialized: true,
    reason: "initialized",
    diagnostic: null
  });
  assert.deepEqual(readJson(join(beforeInit.path, WORKSPACE_MARKER_FILE)), {
    version: WORKSPACE_MARKER_VERSION,
    workspaceId: "ws-a"
  });
  assert.deepEqual(readdirSync(beforeInit.path), [WORKSPACE_MARKER_FILE]);
  assert.equal(resolveWorkspaceDataDir(dir).initialized, true);
  assert.equal(initializeWorkspaceDataDir(dir).reason, "already-initialized");
});

test("workspace-binding: unknown ID, title, path and preset never select", () => {
  const dir = tempMemoryDir();
  const ctx = ctxOf(workspace("ws-a", "Project"));
  assert.equal(setWorkspaceBinding({ memoryDir: dir, workspaceId: "ws-a", ctx }).ok, true);
  const before = readFileSync(bindingPath(dir), "utf8");

  const unknown = setWorkspaceBinding({ memoryDir: dir, workspaceId: "ws-missing", ctx });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.changed, false);
  assert.equal(unknown.reason, "unknown-workspace-id");
  assert.equal(unknown.oldWorkspaceId, "ws-a");
  assert.equal(unknown.newWorkspaceId, "ws-a");
  assert.equal(unknown.requestedWorkspaceId, "ws-missing");
  assert.equal(readFileSync(bindingPath(dir), "utf8"), before);
  assert.equal(readWorkspaceBinding(dir).workspaceId, "ws-a");

  // A title, path or preset is not a registry ID; these fail rather than being
  // coerced, with a different reason than malformed non-string input.
  for (const value of ["Project", "C:\\private\\workspace-path", "private-preset"]) {
    const result = setWorkspaceBinding({ memoryDir: dir, workspaceId: value, ctx });
    assert.equal(result.ok, false);
    assert.equal(result.changed, false);
    assert.equal(result.reason, "unknown-workspace-id");
    assert.equal(result.newWorkspaceId, "ws-a");
  }
  for (const value of ["", "   ", null, 7, { id: "ws-a" }]) {
    const result = setWorkspaceBinding({ memoryDir: dir, workspaceId: value, ctx });
    assert.equal(result.ok, false);
    assert.equal(result.changed, false);
    assert.equal(result.reason, "invalid-workspace-id");
    assert.equal(result.newWorkspaceId, "ws-a");
  }

  assert.equal(readFileSync(bindingPath(dir), "utf8"), before);
  assert.equal(setWorkspaceBinding({ memoryDir: dir, workspaceId: "ws-a", ctx: {} }).ok, false);
  assert.equal(readWorkspaceBinding(dir).workspaceId, "ws-a");
});

test("workspace-binding: initialization refuses a changed binding", () => {
  const dir = tempMemoryDir();
  const ctx = ctxOf(workspace("ws-a", "A"), workspace("ws-b", "B"));
  assert.equal(setWorkspaceBinding({ memoryDir: dir, workspaceId: "ws-a", ctx }).ok, true);
  assert.equal(initializeWorkspaceDataDir(dir, { expectedWorkspaceId: "ws-b" }).reason,
    "binding-changed-during-initialization");
  const result = initializeWorkspaceDataDir(dir, {
    expectedWorkspaceId: "ws-a",
    beforeRename() {
      assert.equal(setWorkspaceBinding({ memoryDir: dir, workspaceId: "ws-b", ctx }).ok, true);
    }
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "binding-changed-during-initialization");
  assert.equal(readWorkspaceBinding(dir).workspaceId, "ws-b");
});

test("workspace-binding: same-title different IDs select independently", () => {
  const dir = tempMemoryDir();
  const ctx = ctxOf(workspace("ws-a", "Project"), workspace("ws-b", "Project"));

  assert.equal(setWorkspaceBinding({ memoryDir: dir, workspaceId: "ws-a", ctx }).ok, true);
  assert.equal(initializeWorkspaceDataDir(dir).workspaceId, "ws-a");
  const first = resolveWorkspaceDataDir(dir).path;

  const switched = setWorkspaceBinding({ memoryDir: dir, workspaceId: "ws-b", ctx });
  assert.equal(switched.ok, true);
  assert.equal(switched.changed, true);
  assert.equal(switched.oldWorkspaceId, "ws-a");
  assert.equal(switched.newWorkspaceId, "ws-b");
  assert.equal(readWorkspaceBinding(dir).workspaceId, "ws-b");

  assert.equal(initializeWorkspaceDataDir(dir).workspaceId, "ws-b");
  const second = resolveWorkspaceDataDir(dir).path;
  assert.notEqual(first, second);
  assert.equal(readJson(join(first, WORKSPACE_MARKER_FILE)).workspaceId, "ws-a");
  assert.equal(readJson(join(second, WORKSPACE_MARKER_FILE)).workspaceId, "ws-b");
});

test("workspace-binding: selection survives a fresh module instance", async () => {
  const dir = tempMemoryDir();
  const ctx = ctxOf(workspace("ws-restart", "Restart"));
  assert.equal(setWorkspaceBinding({ memoryDir: dir, workspaceId: "ws-restart", ctx }).ok, true);

  const fresh = await import(`../src/workspace-binding.js?restart=${Date.now()}`);
  assert.deepEqual(fresh.readWorkspaceBinding(dir), {
    bound: true,
    workspaceId: "ws-restart",
    diagnostic: null,
    reason: "ok"
  });
  assert.equal(fresh.resolveWorkspaceDataDir(dir).workspaceId, "ws-restart");
});

test("workspace-binding: atomic write failure leaves the prior binding and no temp files", () => {
  const dir = tempMemoryDir();
  const ctx = ctxOf(workspace("ws-a", "Project"), workspace("ws-b", "Project"));
  assert.equal(setWorkspaceBinding({ memoryDir: dir, workspaceId: "ws-a", ctx }).ok, true);
  const before = readFileSync(bindingPath(dir), "utf8");

  const failed = setWorkspaceBinding({
    memoryDir: dir,
    workspaceId: "ws-b",
    ctx,
    beforeRename() {
      throw new Error("simulated crash before rename");
    }
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.changed, false);
  assert.equal(failed.reason, "write-failed");
  assert.equal(failed.oldWorkspaceId, "ws-a");
  assert.equal(failed.newWorkspaceId, "ws-a");
  assert.equal(readFileSync(bindingPath(dir), "utf8"), before);
  assert.equal(readWorkspaceBinding(dir).workspaceId, "ws-a");
  assert.deepEqual(tempEntries(dir), [], "failed atomic write must remove its temp file");
  assert.equal(existsSync(workspaceDataDirFor(dir, "ws-b")), false);

  // The same hook proves a first-ever write fails closed as unbound.
  const empty = tempMemoryDir();
  const firstFailure = setWorkspaceBinding({
    memoryDir: empty,
    workspaceId: "ws-a",
    ctx,
    beforeRename() { throw new Error("boom"); }
  });
  assert.equal(firstFailure.ok, false);
  assert.equal(firstFailure.reason, "write-failed");
  assert.equal(firstFailure.oldWorkspaceId, null);
  assert.equal(firstFailure.newWorkspaceId, null);
  assert.equal(existsSync(bindingPath(empty)), false);
  assertUnbound(readWorkspaceBinding(empty));
});

test("workspace-binding: hostile IDs are digested and can never escape the data root", () => {
  const dir = tempMemoryDir();
  const root = workspaceDataRoot(dir);
  const hostile = [
    "../../escape",
    "..\\..\\escape",
    "/absolute/escape",
    "C:\\Windows\\escape",
    "ws/../../escape",
    "ws\u0000null"
  ];

  for (const id of hostile) {
    const path = workspaceDataDirFor(dir, id);
    assert.ok(path, `path should derive for ${JSON.stringify(id)}`);
    assert.equal(path, resolve(root, digestOf(id)));
    assertPathInside(dir, path);
    assert.equal(relative(root, path), digestOf(id), "only the digest may name the directory");
    assert.equal(existsSync(path), false);
  }

  assert.equal(workspaceDataDirFor(dir, ""), null);
  assert.equal(workspaceDataDirFor(dir, { id: "../../escape" }), null);
  assert.equal(resolveWorkspaceDataDir(dir, "").reason, "invalid-workspace-id");

  const ctx = ctxOf(workspace("../../escape", "Hostile"));
  assert.equal(setWorkspaceBinding({ memoryDir: dir, workspaceId: "../../escape", ctx }).ok, true);
  const initialized = initializeWorkspaceDataDir(dir);
  assert.equal(initialized.ok, true);
  assertPathInside(dir, initialized.path);
  assert.equal(initialized.path, resolve(root, digestOf("../../escape")));
  assert.equal(existsSync(resolve(dir, "..", "..", "escape")), false);
  assert.equal(readJson(join(initialized.path, WORKSPACE_MARKER_FILE)).workspaceId, "../../escape");
});

test("workspace-binding: marker mismatch, corrupt marker and legacy directories are rejected", () => {
  const dir = tempMemoryDir();
  const ctx = ctxOf(workspace("ws-a", "Project"), workspace("ws-b", "Project"), workspace("ws-c", "Project"));
  assert.equal(setWorkspaceBinding({ memoryDir: dir, workspaceId: "ws-a", ctx }).ok, true);
  const dataPath = initializeWorkspaceDataDir(dir).path;
  const markerPath = join(dataPath, WORKSPACE_MARKER_FILE);

  writeFileSync(markerPath, JSON.stringify({ version: WORKSPACE_MARKER_VERSION, workspaceId: "ws-b" }), "utf8");
  for (const result of [
    resolveWorkspaceDataDir(dir),
    resolveWorkspaceDataDir(dir, "ws-a"),
    initializeWorkspaceDataDir(dir)
  ]) {
    assert.equal(result.ok, false);
    assert.equal(result.reason, "marker-mismatch");
  }
  assert.equal(readWorkspaceBinding(dir).workspaceId, "ws-a", "a marker mismatch never changes the binding");

  writeFileSync(markerPath, "{broken", "utf8");
  assert.equal(resolveWorkspaceDataDir(dir, "ws-a").reason, "marker-corrupt");

  writeFileSync(markerPath, JSON.stringify({ version: 99, workspaceId: "ws-a" }), "utf8");
  assert.equal(resolveWorkspaceDataDir(dir, "ws-a").reason, "marker-unsupported-version");

  // A populated directory with no marker is legacy and must not be adopted.
  assert.equal(setWorkspaceBinding({ memoryDir: dir, workspaceId: "ws-c", ctx }).ok, true);
  const legacyPath = workspaceDataDirFor(dir, "ws-c");
  mkdirSync(legacyPath, { recursive: true });
  writeFileSync(join(legacyPath, "memory.db"), "legacy-workspace-db", "utf8");

  assert.equal(resolveWorkspaceDataDir(dir).reason, "unmarked-legacy-directory");
  const rejected = initializeWorkspaceDataDir(dir);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "unmarked-legacy-directory");
  assert.equal(existsSync(join(legacyPath, WORKSPACE_MARKER_FILE)), false);
  assert.equal(readFileSync(join(legacyPath, "memory.db"), "utf8"), "legacy-workspace-db");

  // An empty unmarked directory is safe to initialize explicitly.
  const emptyDir = tempMemoryDir();
  assert.equal(setWorkspaceBinding({ memoryDir: emptyDir, workspaceId: "ws-c", ctx }).ok, true);
  const emptyPath = workspaceDataDirFor(emptyDir, "ws-c");
  mkdirSync(emptyPath, { recursive: true });
  assert.equal(resolveWorkspaceDataDir(emptyDir).reason, "empty-uninitialized");
  const filled = initializeWorkspaceDataDir(emptyDir);
  assert.equal(filled.ok, true);
  assert.equal(filled.created, false);
  assert.equal(filled.reason, "initialized");
});

test("workspace-binding: managed workspaces root cannot be a symlink", (t) => {
  const dir = tempMemoryDir();
  const outside = tempMemoryDir();
  const ctx = ctxOf(workspace("ws-a", "Project"));
  assert.equal(setWorkspaceBinding({ memoryDir: dir, workspaceId: "ws-a", ctx }).ok, true);
  try {
    symlinkSync(outside, workspaceDataRoot(dir), "junction");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") return t.skip("junction creation unavailable");
    throw error;
  }
  assert.equal(resolveWorkspaceDataDir(dir).reason, "unsafe-data-root");
  assert.equal(initializeWorkspaceDataDir(dir).reason, "unsafe-data-root");
  assert.deepEqual(readdirSync(outside), []);
});

test("workspace-binding: the legacy root database is never opened, created or migrated", () => {
  const dir = tempMemoryDir();
  const ctx = ctxOf(workspace("ws-a", "Project"));
  const dbPath = join(dir, "memory.db");
  const dbBytes = Buffer.from("SQLite format 3\u0000sentinel-root-database");
  writeFileSync(dbPath, dbBytes);

  assert.equal(setWorkspaceBinding({ memoryDir: dir, workspaceId: "ws-a", ctx }).ok, true);
  assert.equal(initializeWorkspaceDataDir(dir).ok, true);
  assert.equal(unbindWorkspace({ memoryDir: dir }).ok, true);
  assert.deepEqual(readFileSync(dbPath), dbBytes, "root memory.db content must stay byte-identical");
  assert.equal(lstatSync(dbPath).isFile(), true);
  assert.equal(existsSync(join(dir, "memory.db-wal")), false);
  assert.equal(existsSync(join(dir, "memory.db-shm")), false);

  const clean = tempMemoryDir();
  assert.equal(setWorkspaceBinding({ memoryDir: clean, workspaceId: "ws-a", ctx }).ok, true);
  assert.equal(initializeWorkspaceDataDir(clean).ok, true);
  assert.equal(existsSync(join(clean, "memory.db")), false, "no root database may be created");
  assert.deepEqual(readdirSync(clean).sort(), [WORKSPACE_BINDING_FILE, WORKSPACE_DATA_ROOT].sort());
});

test("workspace-binding: two workspaces are fully isolated and can be reselected", () => {
  const dir = tempMemoryDir();
  const ctx = ctxOf(workspace("ws-a", "Project"), workspace("ws-b", "Project"));

  assert.equal(setWorkspaceBinding({ memoryDir: dir, workspaceId: "ws-a", ctx }).ok, true);
  const a = initializeWorkspaceDataDir(dir).path;
  writeFileSync(join(a, "memory.db"), "database-a", "utf8");

  assert.equal(setWorkspaceBinding({ memoryDir: dir, workspaceId: "ws-b", ctx }).ok, true);
  const b = initializeWorkspaceDataDir(dir).path;
  writeFileSync(join(b, "memory.db"), "database-b", "utf8");

  assert.notEqual(a, b);
  assert.equal(readFileSync(join(a, "memory.db"), "utf8"), "database-a");
  assert.equal(readFileSync(join(b, "memory.db"), "utf8"), "database-b");
  assert.deepEqual(readdirSync(a).sort(), ["memory.db", WORKSPACE_MARKER_FILE].sort());
  assert.deepEqual(readdirSync(b).sort(), ["memory.db", WORKSPACE_MARKER_FILE].sort());

  assert.equal(setWorkspaceBinding({ memoryDir: dir, workspaceId: "ws-a", ctx }).ok, true);
  assert.equal(resolveWorkspaceDataDir(dir).path, a);
  assert.equal(readFileSync(join(resolveWorkspaceDataDir(dir).path, "memory.db"), "utf8"), "database-a");
  assert.equal(readFileSync(join(b, "memory.db"), "utf8"), "database-b");
});

test("workspace-binding: explicit unbind is distinguishable from rejected input", () => {
  const dir = tempMemoryDir();
  const ctx = ctxOf(workspace("ws-a", "Project"));

  const absent = unbindWorkspace({ memoryDir: dir });
  assert.equal(absent.ok, true);
  assert.equal(absent.changed, false);
  assert.equal(absent.reason, "already-unbound");
  assert.equal(absent.oldWorkspaceId, null);
  assert.equal(absent.newWorkspaceId, null);

  assert.equal(setWorkspaceBinding({ memoryDir: dir, workspaceId: "ws-a", ctx }).ok, true);
  const dataPath = initializeWorkspaceDataDir(dir).path;

  const unbound = unbindWorkspace({ memoryDir: dir });
  assert.equal(unbound.ok, true);
  assert.equal(unbound.changed, true);
  assert.equal(unbound.reason, "unbound");
  assert.equal(unbound.oldWorkspaceId, "ws-a");
  assert.equal(unbound.newWorkspaceId, null);
  assert.equal(existsSync(bindingPath(dir)), false);
  assertUnbound(readWorkspaceBinding(dir));
  assert.equal(resolveWorkspaceDataDir(dir).reason, "unbound");
  assert.equal(initializeWorkspaceDataDir(dir).reason, "unbound");
  assert.equal(existsSync(dataPath), true, "unbind does not delete workspace data implicitly");

  const rejected = setWorkspaceBinding({ memoryDir: dir, workspaceId: "ws-missing", ctx });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, "unknown-workspace-id");
  assert.notEqual(rejected.reason, "unbound");
  assert.equal(existsSync(bindingPath(dir)), false);

  assert.equal(unbindWorkspace({ memoryDir: "" }).reason, "invalid-memory-dir");
  assert.equal(readWorkspaceBinding("").diagnostic, "invalid-memory-dir");
});
