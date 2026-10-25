// Consistent SQLite snapshots and restart-applied restores for Memory.
//
// A live database is never overwritten by a settings-page request. The page only
// stages a verified backup; the next Host start applies it before createStore()
// opens the database. The current file set is copied to
// <memoryDir>/backups/pre-restore-* first, so a failed restore leaves the live
// database untouched and a successful one remains manually rollback-able.

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";

const BACKUP_DIR = "backups";
const MARKER = ".amadeus-memory-restore.json";
const DB_FILE = "memory.db";
const BACKUP_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]*\.db$/;
const REQUIRED_TABLE = "memories";

function timestamp(now = new Date()) {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function backupDirectory(memoryDir) {
  return join(resolve(memoryDir), BACKUP_DIR);
}

function resolveBackup(memoryDir, name) {
  const dir = backupDirectory(memoryDir);
  const clean = String(name ?? "").trim();
  if (!clean || clean !== basename(clean) || !BACKUP_NAME.test(clean)) {
    const error = new Error("backup name must be a plain .db filename");
    error.status = 400;
    throw error;
  }
  const file = resolve(dir, clean);
  const rel = relative(dir, file);
  if (rel.startsWith("..") || rel.includes("..") || !existsSync(file) || !statSync(file).isFile()) {
    const error = new Error("backup file not found");
    error.status = 404;
    throw error;
  }
  return { dir, file, name: clean };
}

function sqliteHeader(path) {
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(16);
    readSync(fd, header, 0, 16, 0);
    return header.toString("latin1") === "SQLite format 3\u0000";
  } finally {
    closeSync(fd);
  }
}

export function preflightBackup(memoryDir, name) {
  const target = resolveBackup(memoryDir, name);
  if (!sqliteHeader(target.file)) {
    const error = new Error("backup is not a SQLite database");
    error.status = 400;
    throw error;
  }
  const db = new DatabaseSync(target.file, { readOnly: true });
  try {
    const checkRow = db.prepare("PRAGMA quick_check").get();
    const quickCheck = Object.values(checkRow ?? {})[0] ?? "unknown";
    if (quickCheck !== "ok") {
      const error = new Error(`backup integrity check failed: ${quickCheck}`);
      error.status = 422;
      throw error;
    }
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      .map((row) => String(row.name));
    if (!tables.includes(REQUIRED_TABLE)) {
      const error = new Error("backup is not a Memory database (memories table missing)");
      error.status = 422;
      throw error;
    }
    const count = db.prepare(`SELECT COUNT(*) AS n FROM ${REQUIRED_TABLE}`).get();
    return {
      name: target.name,
      bytes: statSync(target.file).size,
      sha256: sha256File(target.file),
      quick_check: quickCheck,
      memories: Number(count?.n ?? 0),
      has_fts: tables.some((table) => /^memories_fts/i.test(table))
    };
  } finally {
    db.close();
  }
}

export function listBackups(memoryDir) {
  const dir = backupDirectory(memoryDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => BACKUP_NAME.test(name))
    .map((name) => {
      const file = join(dir, name);
      const st = statSync(file);
      return {
        name,
        bytes: st.size,
        modified_at: st.mtime.toISOString(),
        sha256: sha256File(file)
      };
    })
    .sort((a, b) => b.modified_at.localeCompare(a.modified_at))
    .slice(0, 50);
}

export function createBackup({ store, memoryDir, now = new Date() }) {
  if (!store?.db || typeof store.db.prepare !== "function") {
    throw new Error("store is not open");
  }
  const dir = backupDirectory(memoryDir);
  ensureDir(dir);
  const base = `amadeus-memory-${timestamp(now)}`;
  let name = `${base}.db`;
  for (let i = 2; existsSync(join(dir, name)); i += 1) name = `${base}-${i}.db`;
  const target = join(dir, name);
  // VACUUM INTO is a consistent snapshot while WAL writers remain open; it does
  // not copy -wal/-shm and never writes into the live database.
  store.db.prepare("VACUUM INTO ?").run(target);
  const check = preflightBackup(memoryDir, name);
  return {
    ...check,
    created_at: now.toISOString(),
    directory: dir
  };
}

export function stageRestore({ memoryDir, name, sha256, now = new Date() }) {
  const check = preflightBackup(memoryDir, name);
  const supplied = String(sha256 ?? "").trim().toLowerCase();
  if (supplied && supplied !== check.sha256) {
    const error = new Error("backup checksum does not match the selected file");
    error.status = 409;
    throw error;
  }
  const marker = join(resolve(memoryDir), MARKER);
  const payload = {
    version: 1,
    backup: check.name,
    sha256: check.sha256,
    staged_at: now.toISOString(),
    memories: check.memories
  };
  const tmp = `${marker}.tmp`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: "utf8" });
  renameSync(tmp, marker);
  return { ...payload, restart_required: true, marker };
}

function copyIfExists(from, to) {
  if (!existsSync(from)) return false;
  copyFileSync(from, to);
  return true;
}

export function applyStagedRestore(memoryDir, { logger = null, now = new Date() } = {}) {
  const root = resolve(memoryDir);
  const marker = join(root, MARKER);
  if (!existsSync(marker)) return { applied: false, reason: "no-staged-restore" };
  const failedMarker = `${marker}.failed-${timestamp(now)}`;
  let payload;
  try {
    payload = JSON.parse(readFileSync(marker, "utf8"));
  } catch (error) {
    try { renameSync(marker, failedMarker); } catch { /* leave for operator */ }
    logger?.warn?.(`[dsh-mneme] staged restore marker is unreadable: ${String(error)}`);
    return { applied: false, error: "unreadable-restore-marker", failed_marker: failedMarker };
  }
  try {
    const target = resolveBackup(root, payload.backup);
    const check = preflightBackup(root, target.name);
    if (String(payload.sha256 ?? "").toLowerCase() !== check.sha256) {
      const error = new Error("staged backup checksum changed");
      error.status = 409;
      throw error;
    }
    const dbPath = join(root, DB_FILE);
    const safetyDir = join(root, BACKUP_DIR, `pre-restore-${timestamp(now)}`);
    ensureDir(safetyDir);
    const safety = { directory: safetyDir, db: false, wal: false, shm: false };
    if (existsSync(dbPath)) {
      copyFileSync(dbPath, join(safetyDir, DB_FILE));
      safety.db = true;
      safety.wal = copyIfExists(`${dbPath}-wal`, join(safetyDir, `${DB_FILE}-wal`));
      safety.shm = copyIfExists(`${dbPath}-shm`, join(safetyDir, `${DB_FILE}-shm`));
    }
    const staging = join(root, `.amadeus-memory-restore-${timestamp(now)}.db`);
    copyFileSync(target.file, staging);
    if (sha256File(staging) !== check.sha256) throw new Error("staged copy checksum mismatch");

    // The live file set is already in safetyDir. Remove only after that copy is
    // complete; on any failure the original files are restored below.
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });
    try {
      copyFileSync(staging, dbPath);
    } catch (error) {
      if (safety.db) copyFileSync(join(safetyDir, DB_FILE), dbPath);
      if (safety.wal) copyFileSync(join(safetyDir, `${DB_FILE}-wal`), `${dbPath}-wal`);
      if (safety.shm) copyFileSync(join(safetyDir, `${DB_FILE}-shm`), `${dbPath}-shm`);
      throw error;
    } finally {
      rmSync(staging, { force: true });
    }
    rmSync(marker, { force: true });
    logger?.info?.(`[dsh-mneme] restored staged backup ${check.name}; safety copy: ${safetyDir}`);
    return { applied: true, backup: check.name, sha256: check.sha256, safety_backup: safetyDir };
  } catch (error) {
    try { renameSync(marker, failedMarker); } catch { /* leave for operator */ }
    logger?.warn?.(`[dsh-mneme] staged restore failed; live database preserved: ${String(error)}`);
    return { applied: false, error: String(error?.message ?? error), failed_marker: failedMarker };
  }
}

export const __backupInternals = { BACKUP_DIR, MARKER, BACKUP_NAME, sqliteHeader };
