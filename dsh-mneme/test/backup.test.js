import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../src/store.js";
import { assertIsolatedMemoryDir } from "../src/qa-guard.js";
import {
  applyStagedRestore,
  createBackup,
  listBackups,
  preflightBackup,
  stageRestore
} from "../src/backup.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", ".test-tmp");
mkdirSync(ROOT, { recursive: true });

function isolatedDir(name) {
  const dir = join(ROOT, `${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  // The guard canonicalizes symlink/junction/case aliases before any store is
  // created; it also rejects the user's default and direct historical paths.
  return assertIsolatedMemoryDir(dir, { qaRoot: ROOT });
}

function seed(dir) {
  const store = createStore(join(dir, "memory.db"));
  store.save({ type: "project", title: "before backup", content: "synthetic backup content", importance: 4 });
  return store;
}

test("backup is consistent, listed, checksum-verified and restores only after restart", () => {
  const dir = isolatedDir("restore");
  try {
    const store = seed(dir);
    const backup = createBackup({ store, memoryDir: dir, now: new Date("2026-10-25T12:00:00Z") });
    assert.equal(backup.memories, 1);
    assert.equal(backup.quick_check, "ok");
    assert.match(backup.sha256, /^[a-f0-9]{64}$/);
    assert.equal(backup.name, "amadeus-memory-20261025T120000Z.db");
    assert.ok(listBackups(dir).some((row) => row.name === backup.name));

    store.save({ type: "project", title: "after backup", content: "must disappear after restore", importance: 3 });
    assert.equal(store.count(), 2);
    store.db.close();

    stageRestore({ memoryDir: dir, name: backup.name, sha256: backup.sha256 });
    const applied = applyStagedRestore(dir);
    assert.equal(applied.applied, true);
    assert.ok(applied.safety_backup);

    const reopened = createStore(join(dir, "memory.db"));
    try {
      assert.equal(reopened.count(), 1);
      assert.equal(reopened.getById(reopened.all()[0].id).title, "before backup");
    } finally {
      reopened.db.close();
    }
    // The staged marker is consumed; a second boot must not restore again.
    assert.deepEqual(applyStagedRestore(dir), { applied: false, reason: "no-staged-restore" });
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("checksum mismatch and path traversal are rejected without touching the live DB", () => {
  const dir = isolatedDir("reject");
  try {
    const store = seed(dir);
    const backup = createBackup({ store, memoryDir: dir, now: new Date("2026-10-25T12:00:01Z") });
    store.db.close();

    assert.throws(() => preflightBackup(dir, "../memory.db"), /plain \.db filename/);
    assert.throws(
      () => stageRestore({ memoryDir: dir, name: backup.name, sha256: "0".repeat(64) }),
      /checksum does not match/
    );

    // A staged marker whose file changes after staging must fail closed.
    stageRestore({ memoryDir: dir, name: backup.name, sha256: backup.sha256 });
    appendFileSync(join(dir, "backups", backup.name), Buffer.from([0]));
    const failed = applyStagedRestore(dir);
    assert.equal(failed.applied, false);
    assert.match(String(failed.error), /integrity|checksum|database/i);
    const reopened = createStore(join(dir, "memory.db"));
    try {
      assert.equal(reopened.count(), 1, "live database must remain readable");
      assert.equal(reopened.all()[0].title, "before backup");
    } finally {
      reopened.db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
