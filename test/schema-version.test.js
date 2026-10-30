import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore, MEMORY_SCHEMA_VERSION } from '../src/store.js';

function withLegacyStore(fn) {
  const root = mkdtempSync(join(tmpdir(), 'amadeus-memory-schema-'));
  const file = join(root, 'memory.db');
  try {
    createStore(file).close();
    const db = new DatabaseSync(file);
    db.exec('PRAGMA user_version = 0');
    db.prepare('INSERT INTO memories (id, type, title, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('legacy-1', 'fact', 'Legacy title', 'Legacy content', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    db.close();
    fn({ root, file });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

test('unversioned Memory store is backed up, adopted and retains rows', () => {
  withLegacyStore(({ root, file }) => {
    createStore(file).close();
    const db = new DatabaseSync(file);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, MEMORY_SCHEMA_VERSION);
    assert.deepEqual({ ...db.prepare('SELECT title, content FROM memories WHERE id = ?').get('legacy-1') },
      { title: 'Legacy title', content: 'Legacy content' });
    db.close();
    const backups = readdirSync(join(root, 'backups')).filter(name => /^memory-before-schema-v1-.*\.db$/.test(name));
    assert.equal(backups.length, 1);
    const backup = new DatabaseSync(join(root, 'backups', backups[0]));
    assert.equal(backup.prepare('PRAGMA user_version').get().user_version, 0);
    assert.equal(backup.prepare('SELECT content FROM memories WHERE id = ?').get('legacy-1').content, 'Legacy content');
    backup.close();
  });
});

test('backup failure does not migrate or discard Memory data', () => {
  withLegacyStore(({ root, file }) => {
    writeFileSync(join(root, 'backups'), 'blocked');
    assert.throws(() => createStore(file), /pre-migration backup failed/);
    const db = new DatabaseSync(file);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0);
    assert.equal(db.prepare('SELECT content FROM memories WHERE id = ?').get('legacy-1').content, 'Legacy content');
    db.close();
  });
});

test('future Memory schema is rejected without modification', () => {
  withLegacyStore(({ file }) => {
    const db = new DatabaseSync(file);
    db.exec('PRAGMA user_version = 2');
    db.close();
    assert.throws(() => createStore(file), /unsupported Memory schema version 2/);
    const check = new DatabaseSync(file);
    assert.equal(check.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(check.prepare('SELECT content FROM memories WHERE id = ?').get('legacy-1').content, 'Legacy content');
    check.close();
  });
});
