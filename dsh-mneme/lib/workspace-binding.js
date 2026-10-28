// Mneme-lite Workspace binding and isolated storage primitive.
//
// The binding is one stable Workspace Registry ID stored in a small JSON file at
// the memoryDir root. It is deliberately outside every workspace database and
// outside `<memoryDir>/workspaces/`. An absent file means unbound. Corrupt or
// unsupported data is reported as unbound with a diagnostic, never widened to
// "all workspaces".
//
// The setter trusts only `workspace.id` values returned by the existing
// workspace-gate `listWorkspaces()`. Titles, paths, presets and caller metadata
// are never accepted or persisted. Writes use a same-directory temp file,
// fsync, and rename so a crash cannot leave a half-written binding.
//
// Workspace data directories are derived from the SHA-256 digest of the stable
// ID, never from the raw ID, which keeps path traversal impossible by
// construction. Resolution is read-only and refuses marker mismatches and
// non-empty unmarked directories. The legacy `<memoryDir>/memory.db` is never
// opened, created or migrated here.
//
// This module does not switch a live plugin runtime. See
// docs/verification/MNEME_LITE_WORKSPACE_BINDING.md for the unresolved concern.

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { checkWorkspaceAccess, listWorkspaces } from "./workspace-gate.js";

export const WORKSPACE_BINDING_FILE = "workspace-binding.json";
export const WORKSPACE_DATA_ROOT = "workspaces";
export const WORKSPACE_MARKER_FILE = ".mneme-workspace.json";
export const UNBOUND_CONTROL_DIR = "unbound";
export const WORKSPACE_BINDING_VERSION = 1;
export const WORKSPACE_MARKER_VERSION = 1;

function memoryRoot(memoryDir) {
  if (typeof memoryDir !== "string" || memoryDir.trim() === "") return null;
  try {
    return resolve(memoryDir);
  } catch {
    return null;
  }
}

function stableId(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function unbound(diagnostic = null) {
  return { bound: false, workspaceId: null, diagnostic, reason: "unbound" };
}

export function workspaceBindingPath(memoryDir) {
  const root = memoryRoot(memoryDir);
  return root === null ? null : join(root, WORKSPACE_BINDING_FILE);
}

export function workspaceDataRoot(memoryDir) {
  const root = memoryRoot(memoryDir);
  return root === null ? null : join(root, WORKSPACE_DATA_ROOT);
}

/**
 * Derive the isolated data directory for a stable workspace ID. This is a pure
 * path derivation: no filesystem access, no registry check and no directory
 * creation. The returned path is always a direct child of
 * `<memoryDir>/workspaces` because only the hex digest is used as the name.
 * @param {string} memoryDir configured memory directory
 * @param {unknown} workspaceId stable workspace ID
 * @returns {string|null} absolute path, or null for invalid input
 */
export function workspaceDataDirFor(memoryDir, workspaceId) {
  const root = workspaceDataRoot(memoryDir);
  const id = stableId(workspaceId);
  if (root === null || id === null) return null;
  const digest = createHash("sha256").update(id, "utf8").digest("hex");
  const target = resolve(root, digest);
  return isInside(root, target) ? target : null;
}

/**
 * Read the persisted binding. Never throws. An absent file is plain unbound;
 * unreadable, corrupt, unsupported or malformed data is unbound with a short
 * generic diagnostic. The diagnostic never includes file contents.
 * @param {string} memoryDir configured memory directory
 * @returns {{bound: boolean, workspaceId: string|null, diagnostic: string|null, reason: string}}
 */
export function readWorkspaceBinding(memoryDir) {
  const file = workspaceBindingPath(memoryDir);
  if (file === null) return unbound("invalid-memory-dir");

  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return unbound();
    return unbound("binding-unreadable");
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return unbound("binding-corrupt");
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return unbound("binding-corrupt");
  }
  if (data.version !== WORKSPACE_BINDING_VERSION) {
    return unbound("binding-unsupported-version");
  }
  const id = stableId(data.workspaceId);
  if (id === null) return unbound("binding-missing-workspace-id");

  return { bound: true, workspaceId: id, diagnostic: null, reason: "ok" };
}

function modelAccess(allowed, reason, workspaceId = null) {
  return { allowed, reason, workspaceId: allowed ? workspaceId : null };
}

/**
 * Build the runtime authorization closure used at every model boundary (tools,
 * prompt injection and autoSummarize).
 *
 * This is deliberately not a cached membership decision:
 *  - the persisted binding is re-read on every call, so selecting a different
 *    Workspace immediately makes an already-mounted store refuse model work;
 *  - a mismatch latches, so switching away and back before a remount still
 *    denies. Process/plugin restart is the only way to adopt a new binding;
 *  - the trusted DSH Session is checked against the active store's Workspace ID
 *    with `checkWorkspaceAccess` (registry read fresh inside that function);
 *  - an unbound runtime has no active workspace ID and therefore never allows.
 *
 * Only the first denial per reason is logged. The log carries a stable reason
 * code, never session data, registry metadata or another Workspace's contents.
 * @param {object} options
 * @param {string} options.memoryDir control root holding the binding file
 * @param {string|null} options.activeWorkspaceId Workspace ID of the open store
 * @param {object} options.ctx trusted DSH context (Workspace Registry)
 * @param {object} [options.logger]
 * @returns {{activeWorkspaceId: string|null, authorize: (session: object) => object}}
 */
export function createWorkspaceAccessGuard({ memoryDir, activeWorkspaceId, ctx, logger = null } = {}) {
  const active = stableId(activeWorkspaceId);
  let stale = false;
  let lastLogged = null;

  const logOnce = (reason) => {
    if (reason === lastLogged) return;
    lastLogged = reason;
    try {
      logger?.warn?.(`[dsh-mneme] model workspace access denied: ${reason}; a remount is required after a Workspace binding change`);
    } catch {
      // Logging must never change the authorization result.
    }
  };

  return {
    activeWorkspaceId: active,
    authorize(session) {
      if (stale) {
        logOnce("binding-changed-pending-remount");
        return modelAccess(false, "binding-changed-pending-remount");
      }

      const binding = readWorkspaceBinding(memoryDir);
      if (!binding.bound) {
        // Absent/corrupt binding means there is no selected Workspace. An
        // unbound runtime must stay denied even if a binding appears later: the
        // open database belongs to the control/unbound root, not to that ID.
        stale = true;
        logOnce("binding-unbound");
        return modelAccess(false, "binding-unbound");
      }
      if (active === null) {
        logOnce("unbound-runtime");
        return modelAccess(false, "unbound-runtime");
      }
      if (binding.workspaceId !== active) {
        stale = true;
        logOnce("binding-changed-pending-remount");
        return modelAccess(false, "binding-changed-pending-remount");
      }

      let access;
      try {
        access = checkWorkspaceAccess(session, active, ctx);
      } catch {
        access = null;
      }
      if (access?.allowed !== true) {
        const reason = access?.reason ?? "access-check-failed";
        logOnce(reason);
        return modelAccess(false, reason);
      }
      return modelAccess(true, "ok", active);
    }
  };
}

function writeJsonAtomic(file, payload, { beforeRename = null } = {}) {
  // Same directory as the target: rename must stay on one filesystem. The pid
  // and random suffix keep concurrent writers from consuming each other's temp.
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  let fd;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (typeof beforeRename === "function") beforeRename(tmp);
    renameSync(tmp, file);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* original error wins */ }
    }
    try { rmSync(tmp, { force: true }); } catch { /* original error wins */ }
    throw error;
  }
}

function bindingResult({ ok, changed, oldWorkspaceId, newWorkspaceId, requestedWorkspaceId, reason, diagnostic = null }) {
  return {
    ok,
    changed,
    oldWorkspaceId,
    newWorkspaceId,
    requestedWorkspaceId,
    reason,
    diagnostic
  };
}

function failedSelection(oldWorkspaceId, requestedWorkspaceId, reason, diagnostic = null) {
  return bindingResult({
    ok: false,
    changed: false,
    oldWorkspaceId,
    newWorkspaceId: oldWorkspaceId,
    requestedWorkspaceId,
    reason,
    diagnostic
  });
}

/**
 * Persist exactly one selected workspace ID after validating it against the
 * live trusted Workspace Registry. Extra registry fields and free-form values
 * are never read. On any validation or write failure the previous binding is
 * left byte-for-byte intact.
 * @param {object} options
 * @param {string} options.memoryDir configured memory directory
 * @param {unknown} options.workspaceId stable workspace ID to select
 * @param {object} options.ctx trusted DSH context for `listWorkspaces`
 * @param {(tmp: string) => void} [options.beforeRename] test-only crash hook
 * @returns {object} ok/changed/old/new IDs plus a stable reason code
 */
export function setWorkspaceBinding({ memoryDir, workspaceId, ctx, beforeRename = null } = {}) {
  const root = memoryRoot(memoryDir);
  const requested = stableId(workspaceId);
  if (root === null) {
    return failedSelection(null, requested, "invalid-memory-dir");
  }

  const previous = readWorkspaceBinding(root);
  const oldWorkspaceId = previous.workspaceId;

  if (requested === null) {
    return failedSelection(oldWorkspaceId, requested, "invalid-workspace-id", previous.diagnostic);
  }

  let workspaces;
  try {
    workspaces = listWorkspaces(ctx);
  } catch {
    workspaces = [];
  }
  if (!workspaces.some((workspace) => workspace.id === requested)) {
    return failedSelection(oldWorkspaceId, requested, "unknown-workspace-id", previous.diagnostic);
  }

  if (oldWorkspaceId === requested) {
    return bindingResult({
      ok: true,
      changed: false,
      oldWorkspaceId,
      newWorkspaceId: oldWorkspaceId,
      requestedWorkspaceId: requested,
      reason: "unchanged",
      diagnostic: previous.diagnostic
    });
  }

  try {
    mkdirSync(root, { recursive: true });
    writeJsonAtomic(
      join(root, WORKSPACE_BINDING_FILE),
      { version: WORKSPACE_BINDING_VERSION, workspaceId: requested },
      { beforeRename }
    );
  } catch {
    return failedSelection(oldWorkspaceId, requested, "write-failed", previous.diagnostic);
  }

  return bindingResult({
    ok: true,
    changed: true,
    oldWorkspaceId,
    newWorkspaceId: requested,
    requestedWorkspaceId: requested,
    reason: "selected",
    diagnostic: previous.diagnostic
  });
}

/**
 * Explicitly remove the binding. This is the only unbind path and is
 * distinguishable from a rejected selection by `ok: true` and reason
 * `unbound` / `already-unbound`. A failed removal leaves the old file intact.
 * @param {object} options
 * @param {string} options.memoryDir configured memory directory
 * @returns {object} ok/changed/old/new IDs plus a stable reason code
 */
export function unbindWorkspace({ memoryDir } = {}) {
  const root = memoryRoot(memoryDir);
  if (root === null) {
    return failedSelection(null, null, "invalid-memory-dir");
  }

  const previous = readWorkspaceBinding(root);
  const file = join(root, WORKSPACE_BINDING_FILE);
  if (!existsSync(file)) {
    return bindingResult({
      ok: true,
      changed: false,
      oldWorkspaceId: previous.workspaceId,
      newWorkspaceId: null,
      requestedWorkspaceId: null,
      reason: "already-unbound",
      diagnostic: previous.diagnostic
    });
  }

  try {
    rmSync(file, { force: true });
  } catch {
    return failedSelection(previous.workspaceId, null, "unbind-failed", previous.diagnostic);
  }

  return bindingResult({
    ok: true,
    changed: true,
    oldWorkspaceId: previous.workspaceId,
    newWorkspaceId: null,
    requestedWorkspaceId: null,
    reason: "unbound",
    diagnostic: previous.diagnostic
  });
}

function readMarker(marker) {
  let stat;
  try {
    stat = lstatSync(marker);
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false };
    return { exists: true, error: "marker-unreadable" };
  }
  if (!stat.isFile()) return { exists: true, error: "marker-not-a-file" };

  let data;
  try {
    data = JSON.parse(readFileSync(marker, "utf8"));
  } catch {
    return { exists: true, error: "marker-corrupt" };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { exists: true, error: "marker-corrupt" };
  }
  if (data.version !== WORKSPACE_MARKER_VERSION) {
    return { exists: true, error: "marker-unsupported-version" };
  }
  const id = stableId(data.workspaceId);
  if (id === null) return { exists: true, error: "marker-missing-workspace-id" };
  return { exists: true, workspaceId: id };
}

function dataDirFailure(workspaceId, reason, diagnostic = null) {
  return {
    ok: false,
    workspaceId,
    path: null,
    exists: false,
    initialized: false,
    reason,
    diagnostic
  };
}

/**
 * Read-only resolution of the isolated data directory. With no explicit
 * workspaceId the current persisted binding is used; an unbound or invalid
 * binding resolves to a failure and never creates anything. With an explicit
 * stable ID only the digest-derived path is inspected. A matching marker is
 * required for a populated directory; a non-empty directory without a marker
 * and a marker for a different workspace are rejected.
 * @param {string} memoryDir configured memory directory
 * @param {unknown} [workspaceId] optional explicit stable workspace ID
 * @returns {object} ok/path/initialized plus a stable reason code
 */
export function resolveWorkspaceDataDir(memoryDir, workspaceId) {
  const root = memoryRoot(memoryDir);
  if (root === null) return dataDirFailure(null, "invalid-memory-dir");

  let id;
  let diagnostic = null;
  if (workspaceId === undefined) {
    const binding = readWorkspaceBinding(root);
    if (!binding.bound) {
      return dataDirFailure(null, "unbound", binding.diagnostic);
    }
    id = binding.workspaceId;
  } else {
    id = stableId(workspaceId);
    if (id === null) return dataDirFailure(null, "invalid-workspace-id");
  }

  const target = workspaceDataDirFor(root, id);
  const dataRoot = workspaceDataRoot(root);
  if (target === null || dataRoot === null || !isInside(dataRoot, target)) {
    return dataDirFailure(id, "unsafe-data-path");
  }

  // A symlinked `workspaces` parent would make a lexically safe digest path
  // write outside memoryDir. The configured memoryDir itself may be an
  // intentional symlink, but this managed child must be a real directory.
  try {
    const rootStat = lstatSync(dataRoot);
    if (!rootStat.isDirectory()) return dataDirFailure(id, "unsafe-data-root");
  } catch (error) {
    if (error?.code !== "ENOENT") return dataDirFailure(id, "data-root-unreadable");
  }

  let stat;
  try {
    stat = lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        ok: true,
        workspaceId: id,
        path: target,
        exists: false,
        initialized: false,
        reason: "absent",
        diagnostic
      };
    }
    return dataDirFailure(id, "data-path-unreadable");
  }
  if (!stat.isDirectory()) return dataDirFailure(id, "data-path-not-directory");

  const marker = readMarker(join(target, WORKSPACE_MARKER_FILE));
  if (marker.exists) {
    if (marker.error) return dataDirFailure(id, marker.error);
    if (marker.workspaceId !== id) return dataDirFailure(id, "marker-mismatch");
    return {
      ok: true,
      workspaceId: id,
      path: target,
      exists: true,
      initialized: true,
      reason: "ok",
      diagnostic
    };
  }

  let entries;
  try {
    entries = readdirSync(target);
  } catch {
    return dataDirFailure(id, "data-path-unreadable");
  }
  if (entries.length > 0) return dataDirFailure(id, "unmarked-legacy-directory");

  return {
    ok: true,
    workspaceId: id,
    path: target,
    exists: true,
    initialized: false,
    reason: "empty-uninitialized",
    diagnostic
  };
}

/**
 * Initialize the isolated data directory for the currently persisted binding.
 * This is the only path that creates `<memoryDir>/workspaces/<digest>`. It
 * requires an existing explicit selection and refuses marker mismatches and
 * non-empty unmarked directories. The marker is written atomically and carries
 * the exact stable workspace ID only. No database is created or opened.
 * @param {string} memoryDir configured memory directory
 * @param {object} [options]
 * @param {(tmp: string) => void} [options.beforeRename] test-only crash hook
 * @returns {object} ok/path/created/initialized plus a stable reason code
 */
export function initializeWorkspaceDataDir(memoryDir, { beforeRename = null, expectedWorkspaceId = null } = {}) {
  const root = memoryRoot(memoryDir);
  if (root === null) return dataDirFailure(null, "invalid-memory-dir");

  const binding = readWorkspaceBinding(root);
  if (!binding.bound) {
    return dataDirFailure(null, "unbound", binding.diagnostic);
  }
  if (expectedWorkspaceId !== null && binding.workspaceId !== expectedWorkspaceId) {
    return dataDirFailure(binding.workspaceId, "binding-changed-during-initialization");
  }

  const resolved = resolveWorkspaceDataDir(root, binding.workspaceId);
  if (!resolved.ok) {
    return dataDirFailure(resolved.workspaceId, resolved.reason, resolved.diagnostic);
  }
  if (resolved.initialized) {
    const current = readWorkspaceBinding(root);
    if (!current.bound || current.workspaceId !== binding.workspaceId) {
      return dataDirFailure(binding.workspaceId, "binding-changed-during-initialization");
    }
    return {
      ok: true,
      workspaceId: resolved.workspaceId,
      path: resolved.path,
      exists: true,
      created: false,
      initialized: true,
      reason: "already-initialized",
      diagnostic: null
    };
  }

  try {
    mkdirSync(resolved.path, { recursive: true });
    writeJsonAtomic(
      join(resolved.path, WORKSPACE_MARKER_FILE),
      { version: WORKSPACE_MARKER_VERSION, workspaceId: binding.workspaceId },
      { beforeRename }
    );
  } catch {
    return dataDirFailure(binding.workspaceId, "initialization-failed");
  }

  const current = readWorkspaceBinding(root);
  if (!current.bound || current.workspaceId !== binding.workspaceId) {
    return dataDirFailure(binding.workspaceId, "binding-changed-during-initialization");
  }

  return {
    ok: true,
    workspaceId: binding.workspaceId,
    path: resolved.path,
    exists: true,
    created: resolved.reason === "absent",
    initialized: true,
    reason: "initialized",
    diagnostic: null
  };
}
