// Experimental Workspace-wide Session ACL. The runtime integration remains
// separately gated by unifiedSessionAclEnabled; opening this store never
// changes visibility in an existing Mneme database.
import { mintTrustedScene } from "./scene.js";
import { AsyncLocalStorage } from "node:async_hooks";

export const UNIFIED_SESSION_ACL_SCHEMA = `
CREATE TABLE IF NOT EXISTS unified_acl_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS unified_session_bindings (
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_unified_bindings_source
  ON unified_session_bindings(workspace_id, source_key);
CREATE TABLE IF NOT EXISTS unified_memory_sources (
  memory_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, source_key)
);
CREATE INDEX IF NOT EXISTS idx_unified_memory_source
  ON unified_memory_sources(source_key, memory_id);
CREATE TRIGGER IF NOT EXISTS trg_unified_memory_sources_delete
  AFTER DELETE ON memories BEGIN
    DELETE FROM unified_memory_sources WHERE memory_id = OLD.id;
  END;
CREATE TABLE IF NOT EXISTS unified_long_term_policies (
  workspace_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  owner_read INTEGER NOT NULL DEFAULT 0 CHECK (owner_read IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, source_key)
);
CREATE TABLE IF NOT EXISTS unified_long_term_grants (
  workspace_id TEXT NOT NULL,
  source_key TEXT NOT NULL,
  reader_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, source_key, reader_key),
  CHECK (source_key <> reader_key)
);
CREATE INDEX IF NOT EXISTS idx_unified_grants_reader
  ON unified_long_term_grants(workspace_id, reader_key, source_key);
`;

const VALID_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const validId = (value) => typeof value === "string" && VALID_ID.test(value);
const trustedIdentities = new WeakMap();
const execution = new AsyncLocalStorage();

export function runWithUnifiedSession(acl, identity, fn) {
  if (trustedIdentities.get(identity) !== acl || !acl.isCurrent(identity) || typeof fn !== "function") {
    throw new TypeError("trusted unified Session required");
  }
  return execution.run({ acl, identity }, fn);
}

export function currentUnifiedSession() {
  const current = execution.getStore() ?? null;
  if (current && !current.acl.isCurrent(current.identity)) {
    throw new Error("UNIFIED_SESSION_INVALID");
  }
  return current;
}

/** SQL predicate for reads before LIMIT/ranking. NULL legacy rows are hidden. */
export function currentUnifiedReadSql(tableAlias = "memories") {
  const current = currentUnifiedSession();
  if (!current) return null;
  if (tableAlias !== "memories" && tableAlias !== "m") throw new TypeError("invalid memory table alias");
  const sources = [...current.acl.readableSources(current.identity)];
  if (!sources.length) return { sql: "0 = 1", params: [] };
  const marks = sources.map(() => "?").join(", ");
  return {
    sql: `((EXISTS (SELECT 1 FROM unified_memory_sources AS ums
             WHERE ums.memory_id = ${tableAlias}.id)
            AND (${tableAlias}.scene_scope IS NULL OR EXISTS
              (SELECT 1 FROM unified_memory_sources AS stamp
               WHERE stamp.memory_id = ${tableAlias}.id
                 AND stamp.source_key = ${tableAlias}.scene_scope))
            AND NOT EXISTS (SELECT 1 FROM unified_memory_sources AS ums
             WHERE ums.memory_id = ${tableAlias}.id AND ums.source_key NOT IN (${marks})))
           OR (NOT EXISTS (SELECT 1 FROM unified_memory_sources AS ums
             WHERE ums.memory_id = ${tableAlias}.id)
             AND ${tableAlias}.scene_scope LIKE 'qq:%'
             AND ${tableAlias}.scene_scope IN (${marks})))`,
    params: [...sources, ...sources]
  };
}

function transaction(db, fn) {
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * This module accepts only Host-resolved Sessions and QQ Scene bindings. It is
 * intentionally independent from recent-activity policies. The administrator
 * surface must authenticate before calling policy mutation methods.
 */
export function createUnifiedSessionAcl({
  db,
  workspaceId,
  resolveTrustedSession,
  authorizeWorkspace,
  resolveTrustedQQScene = null,
  confirmOrdinarySession = null,
  isTrustedOwner = null,
  now = () => new Date().toISOString()
}) {
  if (!db || !validId(workspaceId) || typeof resolveTrustedSession !== "function"
      || typeof authorizeWorkspace !== "function") {
    throw new TypeError("trusted Workspace and Session services required");
  }
  db.exec(UNIFIED_SESSION_ACL_SCHEMA);
  const version = db.prepare("SELECT value FROM unified_acl_meta WHERE key = 'schema_version'").get();
  if (version && version.value !== "1") throw new Error(`UNIFIED_ACL_SCHEMA_UNSUPPORTED: ${version.value}`);
  db.prepare("INSERT OR IGNORE INTO unified_acl_meta (key, value) VALUES ('schema_version', '1')").run();
  const ownsIdentity = (value) => value && typeof value === "object" && trustedIdentities.get(value) === api;

  function identify(sessionId, { bind = true } = {}) {
    if (!validId(sessionId)) return null;
    let session;
    try { session = resolveTrustedSession(sessionId); } catch { return null; }
    if (!session || session.id !== sessionId) return null;
    let access;
    try { access = authorizeWorkspace(session); } catch { return null; }
    if (access?.allowed !== true || access.workspaceId !== workspaceId) return null;

    let scene = null;
    if (typeof resolveTrustedQQScene === "function") {
      let raw;
      // The QQ Host may throw for Sessions it does not manage. Such a Session
      // receives only its own new DSH source; it never falls into the legacy
      // public bucket or inherits a QQ source by title/preset.
      try { raw = resolveTrustedQQScene(sessionId); } catch { raw = null; }
      if (raw !== null && raw !== undefined) {
        try { scene = mintTrustedScene(raw); } catch { return null; }
        if (scene.platform !== "qq") return null;
      }
    }
    const preset = session.header?.agentPreset;
    if (!scene && typeof preset === "string" && preset.startsWith("amadeus-qq")) return null;
    if (!scene && typeof resolveTrustedQQScene === "function") {
      // The QQ Host's inability to bind a Session is not proof that this is
      // an ordinary DSH Session: a paused or renamed QQ Session looks the same.
      // Require a separate, Host-backed negative classification. Preset names
      // and titles must never supply this proof.
      let ordinary = false;
      try { ordinary = confirmOrdinarySession?.(session) === true; } catch { ordinary = false; }
      if (!ordinary) return null;
    }
    const sourceKey = scene ? scene.sceneId : `dsh:session:${sessionId}`;
    const prior = db.prepare(
      "SELECT source_key FROM unified_session_bindings WHERE workspace_id = ? AND session_id = ?"
    ).get(workspaceId, sessionId);
    if (prior && prior.source_key !== sourceKey) return null;
    if (bind && !prior) {
      db.prepare(`INSERT OR IGNORE INTO unified_session_bindings
        (workspace_id, session_id, source_key, created_at) VALUES (?, ?, ?, ?)`).run(
        workspaceId, sessionId, sourceKey, now()
      );
      const stored = db.prepare(
        "SELECT source_key FROM unified_session_bindings WHERE workspace_id = ? AND session_id = ?"
      ).get(workspaceId, sessionId);
      if (stored?.source_key !== sourceKey) return null;
    }
    let owner = false;
    if (scene?.admin === true && scene.kind === "private") {
      try { owner = isTrustedOwner?.(session) === true; } catch { owner = false; }
    }
    const identity = Object.freeze({ sessionId, sourceKey, scene, owner });
    trustedIdentities.set(identity, api);
    return identity;
  }

  function isCurrent(identity) {
    if (!ownsIdentity(identity)) return false;
    const fresh = identify(identity.sessionId, { bind: false });
    return fresh?.sourceKey === identity.sourceKey && fresh?.owner === identity.owner;
  }

  function readableSources(identity) {
    if (!isCurrent(identity)) return new Set();
    const result = new Set([identity.sourceKey]);
    for (const row of db.prepare(`SELECT source_key FROM unified_long_term_grants
      WHERE workspace_id = ? AND reader_key = ?`).all(workspaceId, identity.sourceKey)) {
      result.add(row.source_key);
    }
    if (identity.owner) {
      for (const row of db.prepare(`SELECT source_key FROM unified_long_term_policies
        WHERE workspace_id = ? AND owner_read = 1`).all(workspaceId)) {
        result.add(row.source_key);
      }
    }
    return result;
  }

  function memorySources(memoryId, sceneScope = null) {
    const linked = db.prepare("SELECT source_key FROM unified_memory_sources WHERE memory_id = ?")
      .all(memoryId).map((row) => row.source_key);
    if (linked.length) {
      // A mismatched immutable Scene stamp and source link is corrupt evidence,
      // not a reason to pick whichever attribution gives broader visibility.
      if (typeof sceneScope === "string" && sceneScope && !linked.includes(sceneScope)) return [];
      return linked;
    }
    // Existing QQ data keeps its original stable Scene attribution. Untagged
    // legacy data is quarantined pending an administrator-reviewed migration.
    return typeof sceneScope === "string" && sceneScope.startsWith("qq:")
      ? [sceneScope] : [];
  }

  function canReadMemory(identity, { id, scene_scope: sceneScope } = {}) {
    if (!isCurrent(identity) || !validId(id)) return false;
    const sources = memorySources(id, sceneScope);
    if (!sources.length) return false;
    const readable = readableSources(identity);
    // A mixed-source row cannot be exposed by a grant for only one source.
    return sources.every((source) => readable.has(source));
  }

  function canWriteMemory(identity, { id, scene_scope: sceneScope } = {}) {
    if (!isCurrent(identity) || !validId(id)) return false;
    const sources = memorySources(id, sceneScope);
    return sources.length === 1 && sources[0] === identity.sourceKey;
  }

  function linkMemory(memoryId, identity) {
    if (!validId(memoryId) || !isCurrent(identity)) {
      throw new TypeError("trusted memory source required");
    }
    return transaction(db, () => {
      const memory = db.prepare("SELECT id, scene_scope FROM memories WHERE id = ?").get(memoryId);
      if (!memory) throw new Error("MEMORY_NOT_FOUND");
      const existing = memorySources(memoryId, memory.scene_scope);
      if (existing.some((source) => source !== identity.sourceKey)) {
        throw new Error("CROSS_SOURCE_MEMORY_MERGE_DENIED");
      }
      db.prepare(`INSERT OR IGNORE INTO unified_memory_sources
        (memory_id, source_key, created_at) VALUES (?, ?, ?)`).run(memoryId, identity.sourceKey, now());
      return identity.sourceKey;
    });
  }

  function setOwnerRead(sourceKey, enabled) {
    if (!validId(sourceKey) || typeof enabled !== "boolean") throw new TypeError("invalid policy");
    db.prepare(`INSERT INTO unified_long_term_policies
      (workspace_id, source_key, owner_read, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(workspace_id, source_key) DO UPDATE SET
      owner_read = excluded.owner_read, updated_at = excluded.updated_at`).run(
        workspaceId, sourceKey, enabled ? 1 : 0, now()
      );
  }

  function setGrant(sourceKey, readerKey, enabled) {
    if (!validId(sourceKey) || !validId(readerKey) || sourceKey === readerKey
        || typeof enabled !== "boolean") throw new TypeError("invalid grant");
    if (enabled) {
      db.prepare(`INSERT OR IGNORE INTO unified_long_term_grants
        (workspace_id, source_key, reader_key, created_at) VALUES (?, ?, ?, ?)`).run(
          workspaceId, sourceKey, readerKey, now()
        );
    } else {
      db.prepare(`DELETE FROM unified_long_term_grants
        WHERE workspace_id = ? AND source_key = ? AND reader_key = ?`).run(
          workspaceId, sourceKey, readerKey
        );
    }
  }

  const api = Object.freeze({ identify, isCurrent, readableSources, memorySources, canReadMemory, canWriteMemory,
    linkMemory, setOwnerRead, setGrant });
  return api;
}
