// Stable entity identity, aliases, typed external identifiers and reversible
// canonical links for the Amadeus memory enhancer.
//
// Design constraints (see docs/AMADEUS_MEMORY_ENHANCER.md):
// - Entity UUIDs are immutable: linking never rewrites entities, attrs,
//   relations, memories or their historical rows.
// - Typed external identifiers are authoritative and strictly scoped by
//   (platform, entity_type, external_id). Alias / name similarity is only a
//   suggestion; it never links two records on its own.
// - The canonical mapping is a view. Reads resolve it transitively; undo only
//   deactivates the link, it never reconstructs deleted data.
// - Every mutation appends an audit row. Merge reports are persisted so a
//   confirmation is tied to the dry-run a human actually saw.
import { createHash, randomUUID } from "node:crypto";
import { currentUnifiedSession } from "./unified-session-acl.js";

export const IDENTITY_ENTITY_TYPES = Object.freeze([
  "person", "group", "project", "concept", "technology", "organization"
]);
const ENTITY_TYPE_SET = new Set(IDENTITY_ENTITY_TYPES);
const ACTOR_MAX = 200;
const EXTERNAL_ID_MAX = 200;
const PLATFORM_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ALIAS_MAX = 200;
// Pending assertions are bounded so a hostile/verbose extraction cannot bloat
// the durable graph state. Normal extraction is far below these ceilings.
const MAX_PENDING_RELATIONS = 40;
const MAX_PENDING_ATTRS = 40;
const MAX_PENDING_PAYLOAD_BYTES = 16 * 1024;

// Typed identifiers shipped before any UI/API had a type field: the original
// entity type set. `group` is additive and only covers QQ groups for now.
export const IDENTITY_SCHEMA = `
CREATE TABLE IF NOT EXISTS entity_external_ids (
  id          TEXT PRIMARY KEY,
  entity_id   TEXT NOT NULL,
  platform    TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'confirmed',
  active      INTEGER NOT NULL DEFAULT 1,
  source      TEXT,
  confidence  REAL,
  evidence    TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  revoked_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_ext_active
  ON entity_external_ids(platform, entity_type, external_id) WHERE active = 1;
CREATE INDEX IF NOT EXISTS idx_entity_ext_entity ON entity_external_ids(entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_ext_external ON entity_external_ids(external_id);

CREATE TABLE IF NOT EXISTS entity_aliases (
  id               TEXT PRIMARY KEY,
  entity_id        TEXT NOT NULL,
  alias            TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  entity_type      TEXT,
  provenance       TEXT NOT NULL,
  confidence       REAL,
  confirmed        INTEGER NOT NULL DEFAULT 0,
  active           INTEGER NOT NULL DEFAULT 1,
  evidence         TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  revoked_at       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_alias_active
  ON entity_aliases(entity_id, normalized_alias) WHERE active = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_alias_confirmed
  ON entity_aliases(normalized_alias) WHERE active = 1 AND confirmed = 1;
CREATE INDEX IF NOT EXISTS idx_entity_alias_norm ON entity_aliases(normalized_alias);
CREATE INDEX IF NOT EXISTS idx_entity_alias_entity ON entity_aliases(entity_id);

CREATE TABLE IF NOT EXISTS entity_canonical_links (
  id           TEXT PRIMARY KEY,
  entity_id    TEXT NOT NULL,
  canonical_id TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1,
  source       TEXT,
  evidence     TEXT,
  linked_at    TEXT NOT NULL,
  linked_by    TEXT,
  undone_at    TEXT,
  undone_by    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_canonical_entity_active
  ON entity_canonical_links(entity_id) WHERE active = 1;
CREATE INDEX IF NOT EXISTS idx_canonical_target_active
  ON entity_canonical_links(canonical_id) WHERE active = 1;

CREATE TABLE IF NOT EXISTS identity_pending_assertions (
  id                   TEXT PRIMARY KEY,
  memory_id            TEXT NOT NULL,
  display_name         TEXT NOT NULL,
  normalized_name      TEXT NOT NULL,
  entity_type          TEXT NOT NULL DEFAULT '',
  status               TEXT NOT NULL DEFAULT 'pending',
  payload              TEXT NOT NULL,
  candidate_entity_ids TEXT,
  evidence             TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  resolved_entity_id   TEXT,
  resolved_at          TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_assertion_active
  ON identity_pending_assertions(memory_id, normalized_name, entity_type)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_pending_assertion_name
  ON identity_pending_assertions(normalized_name, status);
CREATE INDEX IF NOT EXISTS idx_pending_assertion_status
  ON identity_pending_assertions(status, updated_at);

CREATE TABLE IF NOT EXISTS identity_pending_relations (
  id                TEXT PRIMARY KEY,
  memory_id         TEXT NOT NULL,
  from_name         TEXT NOT NULL,
  from_normalized   TEXT NOT NULL,
  from_entity_id    TEXT NOT NULL DEFAULT '',
  from_entity_type  TEXT NOT NULL DEFAULT '',
  to_name           TEXT NOT NULL,
  to_normalized     TEXT NOT NULL,
  to_entity_id      TEXT NOT NULL DEFAULT '',
  to_entity_type    TEXT NOT NULL DEFAULT '',
  relation_type     TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',
  evidence          TEXT,
  relation_id       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  resolved_at       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_relation_active
  ON identity_pending_relations(memory_id, from_normalized, to_normalized, relation_type)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_pending_relation_from
  ON identity_pending_relations(from_normalized, status);
CREATE INDEX IF NOT EXISTS idx_pending_relation_to
  ON identity_pending_relations(to_normalized, status);
CREATE INDEX IF NOT EXISTS idx_pending_relation_status
  ON identity_pending_relations(status, updated_at);

CREATE TABLE IF NOT EXISTS entity_merge_reports (
  id              TEXT PRIMARY KEY,
  from_entity     TEXT NOT NULL,
  to_entity       TEXT NOT NULL,
  report          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  created_by      TEXT,
  applied_at      TEXT,
  applied_link_id TEXT,
  undone_at       TEXT,
  undone_by       TEXT
);
CREATE INDEX IF NOT EXISTS idx_merge_reports_pair
  ON entity_merge_reports(from_entity, to_entity, created_at);

CREATE TABLE IF NOT EXISTS identity_audit_events (
  id                TEXT PRIMARY KEY,
  event_type        TEXT NOT NULL,
  entity_id         TEXT,
  related_entity_id TEXT,
  actor             TEXT,
  payload           TEXT NOT NULL,
  evidence          TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_identity_audit_entity ON identity_audit_events(entity_id);
CREATE INDEX IF NOT EXISTS idx_identity_audit_created ON identity_audit_events(created_at);
-- Append-only by construction: no code path updates/deletes audit rows, and
-- these triggers make an accidental future write fail loudly instead of
-- silently rewriting history.
CREATE TRIGGER IF NOT EXISTS identity_audit_no_update
  BEFORE UPDATE ON identity_audit_events
BEGIN SELECT RAISE(ABORT, 'identity_audit_events is append-only'); END;
CREATE TRIGGER IF NOT EXISTS identity_audit_no_delete
  BEFORE DELETE ON identity_audit_events
BEGIN SELECT RAISE(ABORT, 'identity_audit_events is append-only'); END;
`;

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(value) {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ");
}

export function normalizeIdentityKey(value) {
  return normalizeText(value).toLowerCase();
}

function textOrNull(value, max = 2000) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, max);
}

function requireText(value, field, max = 200) {
  const text = normalizeText(value);
  if (!text) throw new IdentityError("invalid-" + field, `${field} must be a non-empty string`);
  if (text.length > max) throw new IdentityError("invalid-" + field, `${field} is too long`);
  return text;
}

function normalizeActor(actor) {
  return requireText(actor, "actor", ACTOR_MAX);
}

export class IdentityError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "IdentityError";
    this.code = code;
    this.details = details;
  }
}

export function normalizePlatform(value) {
  const platform = String(value ?? "").trim().toLowerCase();
  if (!PLATFORM_RE.test(platform)) {
    throw new IdentityError("invalid-platform", "platform must match [a-z0-9][a-z0-9_-]{0,31}");
  }
  return platform;
}

export function normalizeEntityType(value) {
  const type = String(value ?? "").trim().toLowerCase();
  if (!ENTITY_TYPE_SET.has(type)) {
    throw new IdentityError("invalid-entity-type", `entity_type must be one of: ${IDENTITY_ENTITY_TYPES.join(", ")}`);
  }
  return type;
}

// QQ group names are deterministic identifiers: QQ群<id>, QQ 群 <id>, 群<id>
// (optional separator). 5-12 digits is the live QQ group-number range. A
// person never matches this pattern; "群" without digits is untouched.
const QQ_GROUP_RE = /(?:qq\s*群|群)\s*[:：#\-]?\s*(\d{5,12})\b/i;

export function parseExternalIdentifiers(name) {
  const text = normalizeText(name);
  const match = text.match(QQ_GROUP_RE);
  if (!match) return [];
  return [{
    platform: "qq",
    entity_type: "group",
    external_id: match[1],
    confidence: 1,
    source: "name_parse"
  }];
}

/**
 * Seed legacy entity names as *unconfirmed* labels and deterministic QQ group
 * identifiers. Idempotent: an entity that already has any alias row is never
 * re-seeded, so a user unlink stays unlinked across restarts. No cross-record
 * merge happens here; this is additive metadata only.
 */
export function seedIdentitySchema(db) {
  const entities = db.prepare("SELECT id, name, type FROM entities").all();
  if (!entities.length) return;
  const seedAlias = db.prepare(
    `INSERT OR IGNORE INTO entity_aliases
       (id, entity_id, alias, normalized_alias, entity_type, provenance, confidence,
        confirmed, active, evidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'legacy_name', ?, 0, 1, ?, ?, ?)`
  );
  const seedExternal = db.prepare(
    `INSERT OR IGNORE INTO entity_external_ids
       (id, entity_id, platform, entity_type, external_id, status, active, source,
        confidence, evidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'confirmed', 1, 'name_parse', ?, ?, ?, ?)`
  );
  const audit = db.prepare(
    `INSERT INTO identity_audit_events
       (id, event_type, entity_id, related_entity_id, actor, payload, evidence, created_at)
     VALUES (?, ?, ?, NULL, 'migration', ?, ?, ?)`
  );
  const at = nowIso();
  const migrationAuditFor = (entityId) => db.prepare(
    `SELECT payload FROM identity_audit_events
     WHERE entity_id = ? AND event_type IN ('legacy_qq_group_identity', 'legacy_qq_group_duplicate')`
  ).all(entityId).map((row) => parseJson(row.payload, {}));
  const activeExternalOwner = db.prepare(
    `SELECT entity_id FROM entity_external_ids
     WHERE platform = ? AND entity_type = ? AND external_id = ? AND active = 1`
  );
  const run = () => {
    for (const entity of entities) {
      const existingAlias = db.prepare(
        "SELECT 1 AS x FROM entity_aliases WHERE entity_id = ? LIMIT 1"
      ).get(entity.id);
      if (!existingAlias) {
        const alias = normalizeText(entity.name);
        if (alias) {
          seedAlias.run(
            randomUUID(), entity.id, alias, normalizeIdentityKey(alias),
            entity.type ?? null, 1.0,
            JSON.stringify({ reason: "legacy entity name seeded as unconfirmed label" }),
            at, at
          );
        }
      }
      const parsed = parseExternalIdentifiers(entity.name);
      if (!parsed.length) continue;
      const previousType = entity.type ?? null;
      // Person remains a hard boundary even if the nickname looks like a
      // group. Other legacy labels (notably the old extractor's "organization")
      // are reclassified deterministically as group; the previous type is
      // preserved in the audit/evidence payloads.
      if (previousType === "person") continue;
      if (previousType !== "group") {
        db.prepare("UPDATE entities SET type = 'group' WHERE id = ?").run(entity.id);
      }
      const priorAudits = migrationAuditFor(entity.id);
      for (const ext of parsed) {
        if (priorAudits.some((payload) =>
          payload.platform === ext.platform &&
          payload.entity_type === ext.entity_type &&
          payload.external_id === ext.external_id
        )) continue;
        const owner = activeExternalOwner.get(ext.platform, ext.entity_type, ext.external_id);
        if (owner?.entity_id && owner.entity_id !== entity.id) {
          audit.run(
            randomUUID(), "legacy_qq_group_duplicate", entity.id,
            JSON.stringify({
              platform: ext.platform,
              entity_type: ext.entity_type,
              external_id: ext.external_id,
              previous_type: previousType,
              reason: "typed QQ group id already owned by another legacy row; manual merge required"
            }),
            JSON.stringify([{ kind: "entity_name", value: entity.name }]),
            at
          );
          continue;
        }
        if (owner?.entity_id === entity.id) continue;
        const result = seedExternal.run(
          randomUUID(), entity.id, ext.platform, ext.entity_type, ext.external_id,
          ext.confidence,
          JSON.stringify({
            reason: "deterministic QQ group number in legacy entity name",
            previous_type: previousType,
            entity_name: entity.name,
            auto_merge: false
          }),
          at, at
        );
        if (result.changes > 0) {
          audit.run(
            randomUUID(), "legacy_qq_group_identity", entity.id,
            JSON.stringify({
              platform: ext.platform,
              entity_type: ext.entity_type,
              external_id: ext.external_id,
              previous_type: previousType,
              auto_merge: false
            }),
            JSON.stringify([{ kind: "entity_name", value: entity.name }]),
            at
          );
        }
      }
    }
  };
  if (db.isTransaction) run();
  else {
    db.exec("BEGIN");
    try {
      run();
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw error;
    }
  }
}

function toExternalId(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    entity_id: row.entity_id,
    platform: row.platform,
    entity_type: row.entity_type,
    external_id: row.external_id,
    status: row.status,
    active: row.active === 1,
    source: row.source ?? null,
    confidence: row.confidence ?? null,
    evidence: parseJson(row.evidence, []),
    created_at: row.created_at,
    updated_at: row.updated_at,
    revoked_at: row.revoked_at ?? null
  };
}

function toAlias(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    entity_id: row.entity_id,
    alias: row.alias,
    normalized_alias: row.normalized_alias,
    entity_type: row.entity_type ?? null,
    provenance: row.provenance,
    confidence: row.confidence ?? null,
    confirmed: row.confirmed === 1,
    active: row.active === 1,
    evidence: parseJson(row.evidence, []),
    created_at: row.created_at,
    updated_at: row.updated_at,
    revoked_at: row.revoked_at ?? null
  };
}

function toLink(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    entity_id: row.entity_id,
    canonical_id: row.canonical_id,
    active: row.active === 1,
    source: row.source ?? null,
    evidence: parseJson(row.evidence, []),
    linked_at: row.linked_at,
    linked_by: row.linked_by ?? null,
    undone_at: row.undone_at ?? null,
    undone_by: row.undone_by ?? null
  };
}

function parseJson(raw, fallback) {
  if (raw === null || raw === undefined) return fallback;
  try {
    const value = JSON.parse(raw);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function isUniqueConstraint(error) {
  return /UNIQUE constraint failed/i.test(String(error?.message ?? error));
}

function similarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  if (longer.length === 0) return 1;
  // Bounded Levenshtein: entity names are short (rail/browser labels).
  const prev = new Array(shorter.length + 1);
  for (let j = 0; j <= shorter.length; j++) prev[j] = j;
  for (let i = 1; i <= longer.length; i++) {
    let last = prev[0];
    prev[0] = i;
    for (let j = 1; j <= shorter.length; j++) {
      const old = prev[j];
      const cost = longer[i - 1] === shorter[j - 1] ? 0 : 1;
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, last + cost);
      last = old;
    }
  }
  return 1 - prev[shorter.length] / longer.length;
}

export function createIdentityService({ db, store, logger } = {}) {
  if (!db) throw new Error("createIdentityService: db is required");
  if (!store) throw new Error("createIdentityService: store is required");

  db.exec(IDENTITY_SCHEMA);
  seedIdentitySchema(db);

  const entityById = (id) => store.findEntityById(id);

  function appendAudit(event) {
    const at = event.created_at ?? nowIso();
    const id = randomUUID();
    db.prepare(
      `INSERT INTO identity_audit_events
         (id, event_type, entity_id, related_entity_id, actor, payload, evidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      requireText(event.event_type, "event_type", 80),
      event.entity_id ?? null,
      event.related_entity_id ?? null,
      event.actor ?? null,
      JSON.stringify(event.payload ?? {}),
      event.evidence === undefined ? null : JSON.stringify(event.evidence),
      at
    );
    return id;
  }

  // One indexed snapshot per request: entities, active canonical links,
  // active aliases and active external IDs are each read once, then groups are
  // built in memory. This replaces the previous buildGroup()/allGroups()
  // patterns that re-scanned links, aliases and IDs for every entity.
  let lastSnapshotStats = null;

  function canonicalIdOf(entityId) {
    if (!entityId) return entityId;
    let current = entityId;
    const seen = new Set();
    while (current && !seen.has(current)) {
      seen.add(current);
      const row = db.prepare(
        "SELECT canonical_id FROM entity_canonical_links WHERE entity_id = ? AND active = 1"
      ).get(current);
      if (!row) break;
      current = row.canonical_id;
    }
    return current;
  }

  function buildGroupFromSnapshot(snapshot, representative, memberIds) {
    if (!representative) return null;
    const canonicalId = snapshot.resolve(representative.id);
    const rep = snapshot.byId.get(canonicalId) ?? representative;
    const ids = memberIds ?? snapshot.membersByCanonical.get(canonicalId) ?? [canonicalId];
    const members = ids.map((id) => snapshot.byId.get(id)).filter(Boolean);
    const aliases = ids.flatMap((id) => snapshot.aliasesByEntity.get(id) ?? []);
    const externalIds = ids.flatMap((id) => snapshot.externalByEntity.get(id) ?? []);
    const privateView = currentUnifiedSession() !== null;
    return {
      id: rep.id,
      canonical_id: canonicalId,
      name: rep.name,
      type: rep.type ?? null,
      first_seen: privateView ? null : rep.first_seen,
      last_seen: privateView ? null : rep.last_seen,
      mention_count: privateView ? null : members.reduce((sum, m) => sum + (m.mention_count ?? 1), 0),
      mention_count_own: privateView ? null : rep.mention_count ?? 1,
      canonical_memory_id: privateView && rep.canonical_memory_id && !store.getById(rep.canonical_memory_id)
        ? null : rep.canonical_memory_id ?? null,
      merged: ids.length > 1,
      member_ids: ids,
      members: members.map((m) => ({
        id: m.id,
        name: m.name,
        type: m.type ?? null,
        mention_count: privateView ? null : m.mention_count ?? 1,
        last_seen: privateView ? null : m.last_seen
      })),
      aliases: aliases.map((a) => ({
        id: a.id,
        alias: a.alias,
        normalized_alias: a.normalized_alias,
        provenance: a.provenance,
        confirmed: a.confirmed,
        entity_id: a.entity_id
      })),
      external_ids: externalIds,
      // Preserve access to originals: the group view never hides member UUIDs.
      origin_entity_ids: ids
    };
  }

  function loadSnapshot() {
    const entities = store.listEntities({ limit: 1000000 });
    const unified = currentUnifiedSession() !== null;
    // Canonical links carry no trustworthy Session-scoped evidence yet. Even
    // when both nodes are independently visible, the *fact of their merge* may
    // have come from another private source. Keep the global admin graph intact
    // and suppress unevidenced links in the experimental model view.
    const links = unified ? [] : db.prepare(
      "SELECT * FROM entity_canonical_links WHERE active = 1 ORDER BY linked_at, id"
    ).all();
    const aliases = unified ? [] : db.prepare(
      "SELECT * FROM entity_aliases WHERE active = 1 ORDER BY confirmed DESC, created_at, id"
    ).all().map(toAlias);
    const externalIds = unified ? [] : db.prepare(
      "SELECT * FROM entity_external_ids WHERE active = 1 ORDER BY created_at, id"
    ).all().map(toExternalId);
    const byId = new Map(entities.map((entity) => [entity.id, entity]));
    const parent = new Map(links.map((link) => [link.entity_id, link.canonical_id]));
    const resolveCache = new Map();
    const resolve = (entityId) => {
      if (!entityId) return entityId;
      if (resolveCache.has(entityId)) return resolveCache.get(entityId);
      const chain = [];
      const seen = new Set();
      let current = entityId;
      while (current && parent.has(current) && !seen.has(current)) {
        seen.add(current);
        chain.push(current);
        current = parent.get(current);
      }
      for (const id of chain) resolveCache.set(id, current);
      resolveCache.set(entityId, current);
      return current;
    };
    const membersByCanonical = new Map();
    for (const entity of entities) {
      const canonical = resolve(entity.id);
      if (!membersByCanonical.has(canonical)) membersByCanonical.set(canonical, []);
      membersByCanonical.get(canonical).push(entity.id);
    }
    const aliasesByEntity = new Map();
    for (const alias of aliases) {
      if (!aliasesByEntity.has(alias.entity_id)) aliasesByEntity.set(alias.entity_id, []);
      aliasesByEntity.get(alias.entity_id).push(alias);
    }
    const externalByEntity = new Map();
    for (const external of externalIds) {
      if (!externalByEntity.has(external.entity_id)) externalByEntity.set(external.entity_id, []);
      externalByEntity.get(external.entity_id).push(external);
    }
    const snapshot = {
      entities,
      links,
      aliases,
      externalIds,
      byId,
      parent,
      resolve,
      membersByCanonical,
      aliasesByEntity,
      externalByEntity,
      groups: [],
      stats: {
        queries: 4,
        entities: entities.length,
        active_links: links.length,
        active_aliases: aliases.length,
        active_external_ids: externalIds.length
      }
    };
    for (const [canonicalId, memberIds] of membersByCanonical) {
      const group = buildGroupFromSnapshot(snapshot, byId.get(canonicalId), memberIds);
      if (group) snapshot.groups.push(group);
    }
    lastSnapshotStats = snapshot.stats;
    return snapshot;
  }

  function buildGroup(representative, snapshot = loadSnapshot()) {
    if (!representative) return null;
    const canonicalId = snapshot.resolve(representative.id);
    const rep = snapshot.byId.get(canonicalId) ?? representative;
    return buildGroupFromSnapshot(snapshot, rep);
  }

  function allGroups() {
    return loadSnapshot().groups;
  }

  function listEntities({ limit = 500, filter = null } = {}) {
    let groups = allGroups()
      .slice()
      .sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen)) || a.name.localeCompare(b.name));
    if (typeof filter === "function") groups = groups.filter(filter);
    return Number.isInteger(limit) && limit > 0 ? groups.slice(0, limit) : groups;
  }

  function listEntitiesPage({ limit = 500, offset = 0, query = "", publicOnly = false, filter = null } = {}) {
    const all = allGroups()
      .slice()
      .sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen)) || a.name.localeCompare(b.name));
    const key = normalizeIdentityKey(query);
    let filtered = key
      ? all.filter((group) => publicOnly
          ? normalizeIdentityKey(group.name).includes(key)
          : normalizeIdentityKey(group.name).includes(key) ||
            group.aliases.some((alias) => alias.normalized_alias.includes(key)))
      : all;
    if (typeof filter === "function") filtered = filtered.filter(filter);
    const pageSize = Math.max(1, Math.min(1000, Number.isInteger(limit) ? limit : 500));
    const start = Math.max(0, Number.isInteger(offset) ? offset : 0);
    const items = filtered.slice(start, start + pageSize);
    return {
      items,
      total: filtered.length,
      offset: start,
      limit: pageSize,
      has_more: start + items.length < filtered.length,
      query: key
    };
  }

  function groupsMatchingIdentity(raw, { idFirst = true } = {}) {
    const text = normalizeText(raw);
    if (!text) return [];
    const snapshot = loadSnapshot();
    if (idFirst && snapshot.byId.has(text)) {
      const group = buildGroup(snapshot.byId.get(text), snapshot);
      return group ? [group] : [];
    }
    const key = normalizeIdentityKey(text);
    const matches = snapshot.groups.filter((group) => {
      if (normalizeIdentityKey(group.name) === key) return true;
      return group.aliases.some((a) => a.normalized_alias === key);
    });
    if (matches.length) {
      // Confirmed aliases outrank a bare name match, but both can be returned:
      // two people sharing a nickname must become a human choice, not a guess.
      return matches.sort((a, b) => {
        const ac = a.aliases.some((x) => x.confirmed && x.normalized_alias === key) ? 1 : 0;
        const bc = b.aliases.some((x) => x.confirmed && x.normalized_alias === key) ? 1 : 0;
        return bc - ac || a.name.localeCompare(b.name);
      });
    }
    // Exact typed identifiers are trusted keys too (platform/type boundaries
    // still apply to writes; this read path just looks the owner up).
    const byExternal = new Map();
    for (const external of snapshot.externalIds) {
      if (external.external_id !== text) continue;
      const group = buildGroup(snapshot.byId.get(external.entity_id), snapshot);
      if (group) byExternal.set(group.id, group);
    }
    return [...byExternal.values()];
  }

  function groupsMatchingPublicIdentity(raw) {
    const text = normalizeText(raw);
    if (!text) return [];
    const snapshot = loadSnapshot();
    if (snapshot.byId.has(text)) {
      const group = buildGroup(snapshot.byId.get(text), snapshot);
      return group ? [group] : [];
    }
    // Public reads may only match the exact display name. Aliases and typed
    // external identifiers are private and resolve only on authenticated
    // identity routes.
    const key = normalizeIdentityKey(text);
    return snapshot.groups
      .filter((group) => normalizeIdentityKey(group.name) === key)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function resolveAlias(name) {
    const key = normalizeIdentityKey(name);
    if (!key) return [];
    return db.prepare(
      "SELECT * FROM entity_aliases WHERE normalized_alias = ? AND active = 1 AND confirmed = 1 ORDER BY created_at, id"
    ).all(key).map(toAlias);
  }

  function findEntitiesMentionedIn(text, { limit = 5, publicOnly = false } = {}) {
    const hay = String(text ?? "").toLowerCase();
    if (!hay) return [];
    const hits = [];
    for (const group of allGroups()) {
      const labels = publicOnly
        ? new Set([group.name])
        : new Set([group.name, ...group.aliases.map((a) => a.alias)]);
      let best = null;
      for (const label of labels) {
        const normalized = normalizeText(label);
        if (normalized.length < 2) continue;
        if (hay.includes(normalized.toLowerCase())) {
          if (!best || normalized.length > best.length) best = normalized;
        }
      }
      if (best) hits.push({ id: group.id, canonical_id: group.id, name: best, group });
    }
    return hits
      .sort((a, b) => b.name.length - a.name.length || a.id.localeCompare(b.id))
      .slice(0, limit);
  }

  function canonicalizeEntityRows(rows) {
    return rows.map((row) => {
      const group = buildGroup(row);
      return group ? { ...row, ...group, original_id: row.id } : row;
    });
  }

  function loadLinkIndex() {
    const links = db.prepare(
      "SELECT * FROM entity_canonical_links WHERE active = 1 ORDER BY linked_at, id"
    ).all();
    const parent = new Map(links.map((link) => [link.entity_id, link.canonical_id]));
    const resolveCache = new Map();
    const resolve = (entityId) => {
      if (!entityId) return entityId;
      if (resolveCache.has(entityId)) return resolveCache.get(entityId);
      const chain = [];
      const seen = new Set();
      let current = entityId;
      while (current && parent.has(current) && !seen.has(current)) {
        seen.add(current);
        chain.push(current);
        current = parent.get(current);
      }
      for (const id of chain) resolveCache.set(id, current);
      resolveCache.set(entityId, current);
      return current;
    };
    const membersByCanonical = new Map();
    const knownIds = new Set();
    for (const link of links) {
      knownIds.add(link.entity_id);
      knownIds.add(link.canonical_id);
    }
    for (const entityId of knownIds) {
      const canonical = resolve(entityId);
      if (!membersByCanonical.has(canonical)) membersByCanonical.set(canonical, []);
      membersByCanonical.get(canonical).push(entityId);
    }
    return {
      links,
      parent,
      resolve,
      membersByCanonical,
      stats: { queries: 1, active_links: links.length }
    };
  }

  function canonicalizeRelations(rows, snapshot = loadSnapshot()) {
    const out = new Map();
    for (const row of rows) {
      const from = snapshot.resolve(row.from_entity);
      const to = snapshot.resolve(row.to_entity);
      if (from === to) continue; // internal edge after a merge: hidden in the view
      const key = `${from}\u0000${to}\u0000${row.relation_type}`;
      const current = out.get(key);
      const memoryIds = [row.memory_id].filter(Boolean);
      if (!current) {
        out.set(key, {
          ...row,
          id: row.id,
          from_entity: from,
          to_entity: to,
          from,
          to,
          weight: row.weight ?? 1,
          source: row.source ?? "manual",
          edge_ids: [row.id],
          memory_ids: memoryIds,
          memory_id: memoryIds[0] ?? null,
          original_from: row.from_entity,
          original_to: row.to_entity
        });
        continue;
      }
      current.edge_ids.push(row.id);
      if (!current.memory_ids.includes(row.memory_id) && row.memory_id) current.memory_ids.push(row.memory_id);
      current.weight = Math.max(current.weight ?? 1, row.weight ?? 1);
      if (row.memory_id && !current.memory_id) current.memory_id = row.memory_id;
    }
    return [...out.values()];
  }

  function relationsForEntity(entityId) {
    const index = loadLinkIndex();
    const canonical = index.resolve(entityId);
    const memberIds = index.membersByCanonical.get(canonical) ?? [entityId];
    const raw = [];
    for (const memberId of memberIds) raw.push(...store.getRelations(memberId));
    return canonicalizeRelations(raw, index);
  }

  function canonicalizeNeighbors(map, snapshot = loadSnapshot()) {
    const out = new Map();
    for (const [entityId, neighbors] of map) {
      const from = snapshot.resolve(entityId);
      if (!out.has(from)) out.set(from, []);
      const bucket = out.get(from);
      for (const neighbor of neighbors) {
        const to = snapshot.resolve(neighbor);
        if (to !== from && !bucket.includes(to)) bucket.push(to);
      }
    }
    return out;
  }

  function linkedMemoryIds(entityIds) {
    const snapshot = loadSnapshot();
    const ids = [];
    for (const id of entityIds) {
      const group = buildGroup(snapshot.byId.get(id), snapshot);
      if (group) ids.push(...group.member_ids);
    }
    return store.getLinkedMemoryIds([...new Set(ids)]);
  }

  function neighborsOf(entityIds) {
    const snapshot = loadSnapshot();
    const ids = [];
    for (const id of entityIds) {
      const group = buildGroup(snapshot.byId.get(id), snapshot);
      if (group) ids.push(...group.member_ids);
    }
    return canonicalizeNeighbors(store.getEntityNeighbors([...new Set(ids)]), snapshot);
  }

  function externalIdConflict(platform, entityType, externalId, entityId) {
    return db.prepare(
      `SELECT * FROM entity_external_ids
       WHERE platform = ? AND entity_type = ? AND external_id = ? AND active = 1`
    ).get(platform, entityType, externalId)?.entity_id ?? null;
  }

  function assertTypeBoundary(entity, entityType) {
    if (!entity) throw new IdentityError("entity-not-found", "entity not found");
    if (entity.type && entity.type !== entityType) {
      throw new IdentityError(
        "type-boundary",
        `entity ${entity.id} is type ${entity.type}, not ${entityType}`,
        { entity_id: entity.id, entity_type: entity.type, requested_type: entityType }
      );
    }
  }

  function setEntityTypeIfNull(entityId, entityType) {
    db.prepare("UPDATE entities SET type = ? WHERE id = ? AND (type IS NULL OR type = '')").run(entityType, entityId);
  }

  function linkExternalId({ entity_id, platform, entity_type, external_id, actor, source = "manual", confidence = 1, evidence }) {
    if (currentUnifiedSession()) throw new Error("UNIFIED_GLOBAL_MANAGEMENT_REQUIRED");
    const entity = entityById(String(entity_id ?? ""));
    if (!entity) throw new IdentityError("entity-not-found", "entity not found");
    const plat = normalizePlatform(platform);
    const type = normalizeEntityType(entity_type);
    const ext = requireText(external_id, "external-id", EXTERNAL_ID_MAX);
    assertTypeBoundary(entity, type);
    const existingEntity = externalIdConflict(plat, type, ext, entity.id);
    if (existingEntity && existingEntity !== entity.id) {
      throw new IdentityError("external-id-conflict", "external id already belongs to another entity", {
        existing_entity_id: existingEntity
      });
    }
    const at = nowIso();
    const before = db.prepare(
      "SELECT * FROM entity_external_ids WHERE platform = ? AND entity_type = ? AND external_id = ? AND active = 1"
    ).get(plat, type, ext);
    if (before) {
      db.prepare(
        `UPDATE entity_external_ids SET status = 'confirmed', confidence = ?, evidence = COALESCE(?, evidence),
           updated_at = ? WHERE id = ?`
      ).run(confidence, evidence === undefined ? null : JSON.stringify(evidence), at, before.id);
      appendAudit({
        event_type: "external_id_confirm",
        entity_id: entity.id,
        actor: normalizeActor(actor),
        payload: { platform: plat, entity_type: type, external_id: ext, idempotent: true },
        evidence: evidence ?? []
      });
      return toExternalId(db.prepare("SELECT * FROM entity_external_ids WHERE id = ?").get(before.id));
    }
    setEntityTypeIfNull(entity.id, type);
    const id = randomUUID();
    try {
      db.prepare(
        `INSERT INTO entity_external_ids
           (id, entity_id, platform, entity_type, external_id, status, active, source,
            confidence, evidence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'confirmed', 1, ?, ?, ?, ?, ?)`
      ).run(
        id, entity.id, plat, type, ext, textOrNull(source, 80) ?? "manual", confidence,
        evidence === undefined ? null : JSON.stringify(evidence), at, at
      );
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new IdentityError("external-id-conflict", "external id was claimed concurrently", {
          existing_entity_id: externalIdConflict(plat, type, ext, entity.id)
        });
      }
      throw error;
    }
    appendAudit({
      event_type: "external_id_add",
      entity_id: entity.id,
      actor: normalizeActor(actor),
      payload: { platform: plat, entity_type: type, external_id: ext },
      evidence: evidence ?? []
    });
    return toExternalId(db.prepare("SELECT * FROM entity_external_ids WHERE id = ?").get(id));
  }

  function listExternalIds({ entity_id, include_revoked = false } = {}) {
    if (currentUnifiedSession()) return []; // Management records have no authorized evidence view.
    const entity = entityById(String(entity_id ?? ""));
    if (!entity) return [];
    const ids = buildGroup(entity)?.member_ids ?? [entity.id];
    const placeholders = ids.map(() => "?").join(",");
    const activeClause = include_revoked ? "" : "AND active = 1";
    return db.prepare(
      `SELECT * FROM entity_external_ids WHERE entity_id IN (${placeholders}) ${activeClause}
       ORDER BY created_at, id`
    ).all(...ids).map(toExternalId);
  }

  function unlinkExternalId({ id, actor, evidence }) {
    if (currentUnifiedSession()) throw new Error("UNIFIED_GLOBAL_MANAGEMENT_REQUIRED");
    const row = db.prepare("SELECT * FROM entity_external_ids WHERE id = ?").get(String(id ?? ""));
    if (!row || row.active !== 1) throw new IdentityError("external-id-not-found", "active external id not found");
    const at = nowIso();
    db.prepare(
      "UPDATE entity_external_ids SET active = 0, revoked_at = ?, updated_at = ? WHERE id = ?"
    ).run(at, at, row.id);
    appendAudit({
      event_type: "external_id_unlink",
      entity_id: row.entity_id,
      actor: normalizeActor(actor),
      payload: { platform: row.platform, entity_type: row.entity_type, external_id: row.external_id },
      evidence: evidence ?? []
    });
    return toExternalId(db.prepare("SELECT * FROM entity_external_ids WHERE id = ?").get(row.id));
  }

  function aliasConflict(normalizedAlias, entityId) {
    const row = db.prepare(
      "SELECT * FROM entity_aliases WHERE normalized_alias = ? AND active = 1 AND confirmed = 1"
    ).get(normalizedAlias);
    if (!row) return null;
    if (canonicalIdOf(row.entity_id) === canonicalIdOf(entityId)) return null;
    return toAlias(row);
  }

  function createAlias({ entity_id, alias, provenance = "manual", confidence = 0.8, confirmed = false, actor, evidence }) {
    if (currentUnifiedSession()) throw new Error("UNIFIED_GLOBAL_MANAGEMENT_REQUIRED");
    const entity = entityById(String(entity_id ?? ""));
    if (!entity) throw new IdentityError("entity-not-found", "entity not found");
    const label = requireText(alias, "alias", ALIAS_MAX);
    const normalized = normalizeIdentityKey(label);
    const existing = db.prepare(
      "SELECT * FROM entity_aliases WHERE entity_id = ? AND normalized_alias = ? AND active = 1"
    ).get(entity.id, normalized);
    if (existing) {
      if (confirmed && existing.confirmed !== 1) return confirmAlias({ id: existing.id, actor, evidence });
      return toAlias(existing);
    }
    if (confirmed) {
      const conflict = aliasConflict(normalized, entity.id);
      if (conflict) {
        throw new IdentityError("alias-conflict", "confirmed alias already belongs to another entity", {
          existing_entity_id: conflict.entity_id
        });
      }
    }
    const at = nowIso();
    const id = randomUUID();
    try {
      db.prepare(
        `INSERT INTO entity_aliases
           (id, entity_id, alias, normalized_alias, entity_type, provenance, confidence,
            confirmed, active, evidence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
      ).run(
        id, entity.id, label, normalized, entity.type ?? null, textOrNull(provenance, 40) ?? "manual",
        confidence, confirmed ? 1 : 0,
        evidence === undefined ? null : JSON.stringify(evidence), at, at
      );
    } catch (error) {
      if (isUniqueConstraint(error)) {
        throw new IdentityError("alias-conflict", "alias was claimed concurrently", {
          existing_entity_id: aliasConflict(normalized, entity.id)?.entity_id ?? null
        });
      }
      throw error;
    }
    appendAudit({
      event_type: confirmed ? "alias_add_confirmed" : "alias_add",
      entity_id: entity.id,
      actor: normalizeActor(actor),
      payload: { alias: label, normalized_alias: normalized, provenance },
      evidence: evidence ?? []
    });
    return toAlias(db.prepare("SELECT * FROM entity_aliases WHERE id = ?").get(id));
  }

  function toPendingAssertion(row) {
    if (!row) return undefined;
    return {
      id: row.id,
      memory_id: row.memory_id,
      display_name: row.display_name,
      normalized_name: row.normalized_name,
      entity_type: row.entity_type || null,
      status: row.status,
      payload: parseJson(row.payload, {}),
      candidate_entity_ids: parseJson(row.candidate_entity_ids, []),
      evidence: parseJson(row.evidence, []),
      created_at: row.created_at,
      updated_at: row.updated_at,
      resolved_entity_id: row.resolved_entity_id ?? null,
      resolved_at: row.resolved_at ?? null
    };
  }

  function recordPendingAssertion({
    memory_id, display_name, entity_type = "", attrs = [], relations = [],
    candidates = [], evidence = [], actor = "entity_extractor"
  }) {
    const memoryId = String(memory_id ?? "");
    const unified = currentUnifiedSession();
    if (unified && !unified.acl.canWriteMemory(unified.identity, store.getById(memoryId))) {
      throw new Error("UNIFIED_WRITE_NOT_OWNED");
    }
    const name = normalizeText(display_name);
    if (!memoryId || !name) return undefined;
    const type = String(entity_type ?? "");
    const normalized = normalizeIdentityKey(name);
    const candidateIds = [...new Set(candidates.flatMap((group) => [
      group.id, ...(group.member_ids ?? [])
    ]).filter(Boolean))];
    const boundedAttrs = attrs.slice(0, MAX_PENDING_ATTRS).map((attr) => ({
      key: attr.key,
      value: attr.value,
      confidence: attr.confidence ?? null
    }));
    let boundedRelations = relations.slice(0, MAX_PENDING_RELATIONS).map((rel) => ({
      from_name: rel.from_name,
      from_entity_id: rel.from_entity_id ?? null,
      to_name: rel.to_name,
      to_entity_id: rel.to_entity_id ?? null,
      relation_type: rel.relation_type
    }));
    let truncated = attrs.length > MAX_PENDING_ATTRS || relations.length > MAX_PENDING_RELATIONS;
    const serialized = () => JSON.stringify({
      attrs: boundedAttrs,
      relations: boundedRelations,
      truncated
    });
    // Hard byte ceiling: drop trailing relations, then attrs, then fall back to
    // names/evidence only. Material is never silently unbounded.
    while (Buffer.byteLength(serialized(), "utf8") > MAX_PENDING_PAYLOAD_BYTES && boundedRelations.length) {
      boundedRelations = boundedRelations.slice(0, -1);
      truncated = true;
    }
    while (Buffer.byteLength(serialized(), "utf8") > MAX_PENDING_PAYLOAD_BYTES && boundedAttrs.length) {
      boundedAttrs.pop();
      truncated = true;
    }
    const payload = Buffer.byteLength(serialized(), "utf8") > MAX_PENDING_PAYLOAD_BYTES
      ? JSON.stringify({ attrs: [], relations: [], truncated: true })
      : serialized();
    const evidenceJson = JSON.stringify(evidence ?? []);
    const at = nowIso();
    const existing = db.prepare(
      `SELECT id FROM identity_pending_assertions
       WHERE memory_id = ? AND normalized_name = ? AND entity_type = ? AND status = 'pending'`
    ).get(memoryId, normalized, type);
    if (existing) {
      db.prepare(
        `UPDATE identity_pending_assertions
         SET payload = ?, candidate_entity_ids = ?, evidence = ?, updated_at = ?
         WHERE id = ?`
      ).run(payload, JSON.stringify(candidateIds), evidenceJson, at, existing.id);
      return toPendingAssertion(db.prepare("SELECT * FROM identity_pending_assertions WHERE id = ?").get(existing.id));
    }
    const id = randomUUID();
    try {
      db.prepare(
        `INSERT INTO identity_pending_assertions
           (id, memory_id, display_name, normalized_name, entity_type, status, payload,
            candidate_entity_ids, evidence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`
      ).run(id, memoryId, name, normalized, type, payload, JSON.stringify(candidateIds), evidenceJson, at, at);
    } catch (error) {
      if (!isUniqueConstraint(error)) throw error;
      // A concurrent extraction won the pending row; reuse it.
      const row = db.prepare(
        `SELECT * FROM identity_pending_assertions
         WHERE memory_id = ? AND normalized_name = ? AND entity_type = ? AND status = 'pending'`
      ).get(memoryId, normalized, type);
      return toPendingAssertion(row);
    }
    appendAudit({
      event_type: "pending_identity_recorded",
      entity_id: null,
      actor: normalizeActor(actor),
      payload: { memory_id: memoryId, name, entity_type: type, candidate_entity_ids: candidateIds },
      evidence: evidence ?? []
    });
    return toPendingAssertion(db.prepare("SELECT * FROM identity_pending_assertions WHERE id = ?").get(id));
  }

  function toPendingRelation(row) {
    if (!row) return undefined;
    return {
      id: row.id,
      memory_id: row.memory_id,
      from_name: row.from_name,
      from_normalized: row.from_normalized,
      from_entity_id: row.from_entity_id || null,
      from_entity_type: row.from_entity_type || null,
      to_name: row.to_name,
      to_normalized: row.to_normalized,
      to_entity_id: row.to_entity_id || null,
      to_entity_type: row.to_entity_type || null,
      relation_type: row.relation_type,
      status: row.status,
      evidence: parseJson(row.evidence, []),
      relation_id: row.relation_id ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      resolved_at: row.resolved_at ?? null
    };
  }

  /**
   * Persist a relation that involves at least one unresolved endpoint. The row
   * is independent of the per-entity assertion rows so it can wait for both
   * endpoints and is retried after each human confirmation.
   */
  function recordPendingRelation({
    memory_id, from_name, from_entity_id, from_entity_type,
    to_name, to_entity_id, to_entity_type, relation_type,
    evidence = [], actor = "entity_extractor"
  }) {
    const memoryId = String(memory_id ?? "");
    const unified = currentUnifiedSession();
    if (unified && !unified.acl.canWriteMemory(unified.identity, store.getById(memoryId))) {
      throw new Error("UNIFIED_WRITE_NOT_OWNED");
    }
    const from = normalizeText(from_name);
    const to = normalizeText(to_name);
    const fromKey = normalizeIdentityKey(from);
    const toKey = normalizeIdentityKey(to);
    const type = String(relation_type ?? "").trim();
    if (!memoryId || !fromKey || !toKey || !type) return undefined;
    const at = nowIso();
    const existing = db.prepare(
      `SELECT * FROM identity_pending_relations
       WHERE memory_id = ? AND from_normalized = ? AND to_normalized = ?
         AND relation_type = ? AND status = 'pending'`
    ).get(memoryId, fromKey, toKey, type);
    const fromId = String(from_entity_id ?? "");
    const toId = String(to_entity_id ?? "");
    if (existing) {
      db.prepare(
        `UPDATE identity_pending_relations
         SET from_name = ?, from_entity_id = ?, from_entity_type = ?,
             to_name = ?, to_entity_id = ?, to_entity_type = ?,
             evidence = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`
      ).run(
        from, fromId || existing.from_entity_id, String(from_entity_type || existing.from_entity_type || ""),
        to, toId || existing.to_entity_id, String(to_entity_type || existing.to_entity_type || ""),
        JSON.stringify(evidence ?? []), at, existing.id
      );
      return toPendingRelation(db.prepare("SELECT * FROM identity_pending_relations WHERE id = ?").get(existing.id));
    }
    const id = randomUUID();
    try {
      db.prepare(
        `INSERT INTO identity_pending_relations
           (id, memory_id, from_name, from_normalized, from_entity_id, from_entity_type,
            to_name, to_normalized, to_entity_id, to_entity_type, relation_type, status,
            evidence, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
      ).run(
        id, memoryId, from, fromKey, fromId, String(from_entity_type ?? ""),
        to, toKey, toId, String(to_entity_type ?? ""), type, JSON.stringify(evidence ?? []), at, at
      );
    } catch (error) {
      if (!isUniqueConstraint(error)) throw error;
      return toPendingRelation(db.prepare(
        `SELECT * FROM identity_pending_relations
         WHERE memory_id = ? AND from_normalized = ? AND to_normalized = ?
           AND relation_type = ? AND status = 'pending'`
      ).get(memoryId, fromKey, toKey, type));
    }
    appendAudit({
      event_type: "pending_relation_recorded",
      entity_id: null,
      actor: normalizeActor(actor),
      payload: { memory_id: memoryId, from, to, relation_type: type },
      evidence: evidence ?? []
    });
    return toPendingRelation(db.prepare("SELECT * FROM identity_pending_relations WHERE id = ?").get(id));
  }

  function listPendingRelations({ status = "pending", limit = 200 } = {}) {
    if (currentUnifiedSession()) return []; // Management records have no authorized evidence view.
    return db.prepare(
      `SELECT * FROM identity_pending_relations
       WHERE (? = '' OR status = ?) ORDER BY updated_at DESC, id LIMIT ?`
    ).all(String(status ?? ""), String(status ?? ""), Math.max(1, Math.min(500, limit))).map(toPendingRelation);
  }

  function resolvePendingRelationEndpoint(row, side, snapshot, {
    entity = null, normalizedAlias = null, explicit = null
  } = {}) {
    const name = row[`${side}_name`];
    const key = row[`${side}_normalized`];
    const expectedType = row[`${side}_entity_type`] || null;
    const storedId = row[`${side}_entity_id`] || null;
    const typeMatches = (candidate) =>
      !expectedType || !candidate?.type || expectedType === candidate.type;
    if (storedId) {
      const stored = entityById(storedId);
      if (!stored) return { ok: false, reason: "missing-stored-entity" };
      if (!typeMatches(stored)) return { ok: false, reason: "type-boundary" };
      return { ok: true, entity: stored };
    }
    if (explicit && explicit.memory_id === row.memory_id && explicit.normalized_name === key) {
      if (!typeMatches(explicit.entity)) return { ok: false, reason: "type-boundary" };
      return { ok: true, entity: explicit.entity };
    }
    // Same-name ambiguity is a hard barrier: even a confirmed alias is not
    // enough when multiple stable-ID people/groups share the label. A stored ID
    // or an explicit per-source selection is required.
    const sameName = snapshot.groups.filter((group) => {
      if (!typeMatches(group)) return false;
      return normalizeIdentityKey(group.name) === key ||
        group.aliases.some((alias) => alias.active && alias.normalized_alias === key);
    });
    if (sameName.length > 1) return { ok: false, reason: "ambiguous-entity" };
    if (entity && normalizedAlias === key) {
      if (!typeMatches(entity)) return { ok: false, reason: "type-boundary" };
      return { ok: true, entity };
    }
    const confirmed = sameName.filter((group) =>
      group.aliases.some((alias) => alias.active && alias.confirmed && alias.normalized_alias === key)
    );
    if (confirmed.length === 1) {
      const resolved = snapshot.byId.get(confirmed[0].id) ?? entityById(confirmed[0].id);
      if (!resolved) return { ok: false, reason: "missing-confirmed-entity" };
      if (!typeMatches(resolved)) return { ok: false, reason: "type-boundary" };
      return { ok: true, entity: resolved };
    }
    return { ok: false, reason: "unresolved" };
  }

  function markPendingRelationStale(row, actor, reason) {
    const at = nowIso();
    db.prepare(
      `UPDATE identity_pending_relations
       SET status = 'stale', resolved_at = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`
    ).run(at, at, row.id);
    appendAudit({
      event_type: "pending_relation_stale",
      entity_id: null,
      actor: normalizeActor(actor),
      payload: { pending_relation_id: row.id, memory_id: row.memory_id, reason },
      evidence: parseJson(row.evidence, [])
    });
  }

  /**
   * Retry pending relations involving one newly confirmed/selected endpoint.
   * Relations are only written when both endpoints are unambiguous and their
   * types still satisfy the person/group boundary.
   */
  function recoverPendingRelationsForEntity(entity, normalizedAlias, actor = "human", evidence = [], {
    explicitMemoryId = null, explicitEntityId = null
  } = {}) {
    if (currentUnifiedSession()) throw new Error("UNIFIED_GLOBAL_MANAGEMENT_REQUIRED");
    if (!entity || !normalizedAlias) return [];
    const rows = db.prepare(
      `SELECT * FROM identity_pending_relations
       WHERE status = 'pending' AND (from_normalized = ? OR to_normalized = ?)`
    ).all(normalizedAlias, normalizedAlias);
    if (!rows.length) return [];
    const ownTransaction = !db.isTransaction;
    if (ownTransaction) db.exec("BEGIN IMMEDIATE");
    const snapshot = loadSnapshot();
    const explicit = explicitMemoryId && explicitEntityId
      ? {
          memory_id: explicitMemoryId,
          normalized_name: normalizedAlias,
          entity: entityById(explicitEntityId) ?? entity
        }
      : null;
    const applied = [];
    try {
      for (const row of rows) {
        const source = store.getById(row.memory_id);
        if (!source || source.forgotten) {
          markPendingRelationStale(row, actor, source ? "source-forgotten" : "source-missing");
          continue;
        }
        const from = resolvePendingRelationEndpoint(row, "from", snapshot, {
          entity, normalizedAlias, explicit
        });
        const to = resolvePendingRelationEndpoint(row, "to", snapshot, {
          entity, normalizedAlias, explicit
        });
        if (from.ok && to.ok) {
          let relation = store.getRelations(from.entity.id).find((candidate) =>
            candidate.memory_id === row.memory_id &&
            candidate.from_entity === from.entity.id &&
            candidate.to_entity === to.entity.id &&
            candidate.relation_type === row.relation_type
          );
          if (!relation) {
            relation = store.saveRelation({
              from_entity: from.entity.id,
              to_entity: to.entity.id,
              relation_type: row.relation_type,
              memory_id: row.memory_id,
              source: "pending_identity_recovery",
              metadata: { recovered_from_pending_relation: row.id }
            });
          }
          const at = nowIso();
          db.prepare(
            `UPDATE identity_pending_relations
             SET status = 'applied', from_entity_id = ?, to_entity_id = ?,
                 relation_id = ?, resolved_at = ?, updated_at = ?
             WHERE id = ? AND status = 'pending'`
          ).run(from.entity.id, to.entity.id, relation?.id ?? null, at, at, row.id);
          appendAudit({
            event_type: "pending_relation_applied",
            entity_id: from.entity.id,
            related_entity_id: to.entity.id,
            actor: normalizeActor(actor),
            payload: {
              pending_relation_id: row.id,
              memory_id: row.memory_id,
              relation_type: row.relation_type,
              relation_id: relation?.id ?? null
            },
            evidence: parseJson(row.evidence, [])
          });
          applied.push({ id: row.id, relation_id: relation?.id ?? null });
          continue;
        }
        // Preserve a human-confirmed UUID even while the other endpoint waits.
        const fromId = from.ok ? from.entity.id : row.from_entity_id;
        const toId = to.ok ? to.entity.id : row.to_entity_id;
        if (fromId !== row.from_entity_id || toId !== row.to_entity_id) {
          db.prepare(
            `UPDATE identity_pending_relations
             SET from_entity_id = ?, to_entity_id = ?, updated_at = ?
             WHERE id = ? AND status = 'pending'`
          ).run(fromId || "", toId || "", nowIso(), row.id);
        }
      }
      if (ownTransaction) db.exec("COMMIT");
      return applied;
    } catch (error) {
      if (ownTransaction) {
        try { db.exec("ROLLBACK"); } catch { /* ignore */ }
      }
      throw error;
    }
  }

  function applyPendingAssertionRow(row, entity, actor, { markStale = false } = {}) {
    const payload = parseJson(row.payload, {});
    const attrs = Array.isArray(payload.attrs) ? payload.attrs : [];
    const relations = Array.isArray(payload.relations) ? payload.relations : [];
    const at = nowIso();
    let appliedAttrs = 0;
    let appliedRelations = 0;
    const ownTransaction = !db.isTransaction;
    if (ownTransaction) db.exec("BEGIN IMMEDIATE");
    const body = () => {
      const source = store.getById(row.memory_id);
      if (!source || source.forgotten) {
        const reason = source ? "source-forgotten" : "source-missing";
        if (markStale) {
          db.prepare(
            `UPDATE identity_pending_assertions
             SET status = 'stale', resolved_at = ?, updated_at = ?
             WHERE id = ? AND status = 'pending'`
          ).run(at, at, row.id);
          appendAudit({
            event_type: "pending_identity_stale",
            entity_id: entity.id,
            actor: normalizeActor(actor),
            payload: { pending_id: row.id, memory_id: row.memory_id, reason },
            evidence: parseJson(row.evidence, [])
          });
          return false;
        }
        throw new IdentityError(
          "pending-source-unavailable",
          `source memory is ${source ? "forgotten" : "missing"}; pending assertion was not applied`
        );
      }
      const unresolvedKey = row.normalized_name;
      for (const attr of attrs) {
        if (typeof attr.key !== "string" || typeof attr.value !== "string") continue;
        store.saveAttr({
          entity_id: entity.id,
          attr_key: attr.key,
          attr_value: attr.value,
          memory_id: row.memory_id,
          confidence: attr.confidence ?? null,
          source: "pending_identity_recovery"
        });
        appliedAttrs++;
      }
      for (const rel of relations) {
        if (!rel || typeof rel.relation_type !== "string") continue;
        const fromNameKey = normalizeIdentityKey(rel.from_name);
        const toNameKey = normalizeIdentityKey(rel.to_name);
        let from = rel.from_entity_id ?? null;
        let to = rel.to_entity_id ?? null;
        if (!from && fromNameKey === unresolvedKey) from = entity.id;
        if (!to && toNameKey === unresolvedKey) to = entity.id;
        if (!from || !to) continue;
        store.saveRelation({
          from_entity: from,
          to_entity: to,
          relation_type: rel.relation_type,
          memory_id: row.memory_id,
          source: "pending_identity_recovery",
          metadata: { recovered_from_pending: row.id }
        });
        appliedRelations++;
      }
      db.prepare(
        `UPDATE identity_pending_assertions
         SET status = 'applied', resolved_entity_id = ?, resolved_at = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`
      ).run(entity.id, at, at, row.id);
      appendAudit({
        event_type: "pending_identity_applied",
        entity_id: entity.id,
        actor: normalizeActor(actor),
        payload: {
          pending_id: row.id,
          memory_id: row.memory_id,
          attrs: appliedAttrs,
          relations: appliedRelations
        },
        evidence: parseJson(row.evidence, [])
      });
      return true;
    };
    try {
      const applied = body();
      if (ownTransaction) db.exec("COMMIT");
      return applied
        ? { attrs: appliedAttrs, relations: appliedRelations }
        : { stale: true, attrs: 0, relations: 0 };
    } catch (error) {
      if (ownTransaction) {
        try { db.exec("ROLLBACK"); } catch { /* ignore */ }
      }
      throw error;
    }
  }

  function recoverPendingAssertionsForEntity(entity, normalizedAlias, actor = "human", evidence = []) {
    if (currentUnifiedSession()) throw new Error("UNIFIED_GLOBAL_MANAGEMENT_REQUIRED");
    if (!entity || !normalizedAlias) return [];
    const rows = db.prepare(
      `SELECT * FROM identity_pending_assertions
       WHERE normalized_name = ? AND status = 'pending'`
    ).all(normalizedAlias);
    if (!rows.length) return [];
    const snapshot = loadSnapshot();
    const target = snapshot.resolve(entity.id);
    const applied = [];
    for (const row of rows) {
      if (row.entity_type && entity.type && row.entity_type !== entity.type) continue;
      const candidates = parseJson(row.candidate_entity_ids, []);
      const canonicalCandidates = [...new Set(candidates.map((id) => snapshot.resolve(id)))];
      // Only a single safe canonical candidate may be recovered automatically.
      // Ambiguous same-name assertions stay pending until an explicit selection.
      if (canonicalCandidates.length !== 1 || canonicalCandidates[0] !== target) continue;
      const result = applyPendingAssertionRow(row, entity, actor, { markStale: true });
      if (!result.stale) applied.push({ id: row.id, ...result });
    }
    if (applied.length) {
      appendAudit({
        event_type: "pending_identity_recovery",
        entity_id: entity.id,
        actor: normalizeActor(actor),
        payload: { applied },
        evidence
      });
    }
    return applied;
  }

  function resolvePendingAssertion({ id, entity_id, actor = "human", evidence = [] }) {
    if (currentUnifiedSession()) throw new Error("UNIFIED_GLOBAL_MANAGEMENT_REQUIRED");
    const row = db.prepare(
      "SELECT * FROM identity_pending_assertions WHERE id = ? AND status = 'pending'"
    ).get(String(id ?? ""));
    if (!row) throw new IdentityError("pending-not-found", "pending assertion not found");
    const entity = entityById(String(entity_id ?? ""));
    if (!entity) throw new IdentityError("entity-not-found", "entity not found");
    if (row.entity_type && entity.type && row.entity_type !== entity.type) {
      throw new IdentityError("type-boundary", "pending assertion type does not match entity");
    }
    const ownTransaction = !db.isTransaction;
    if (ownTransaction) db.exec("BEGIN IMMEDIATE");
    try {
      const result = applyPendingAssertionRow(row, entity, actor);
      const relations = recoverPendingRelationsForEntity(
        entity, row.normalized_name, actor, evidence,
        { explicitMemoryId: row.memory_id, explicitEntityId: entity.id }
      );
      if (ownTransaction) db.exec("COMMIT");
      return { ...result, pending_relations: relations };
    } catch (error) {
      if (ownTransaction) {
        try { db.exec("ROLLBACK"); } catch { /* ignore */ }
      }
      throw error;
    }
  }

  function listPendingAssertions({ status = "pending", limit = 100 } = {}) {
    if (currentUnifiedSession()) return []; // Management records have no authorized evidence view.
    return db.prepare(
      `SELECT * FROM identity_pending_assertions
       WHERE (? = '' OR status = ?) ORDER BY updated_at DESC, id LIMIT ?`
    ).all(String(status ?? ""), String(status ?? ""), Math.max(1, Math.min(500, limit))).map(toPendingAssertion);
  }

  function confirmAlias({ id, actor, evidence }) {
    if (currentUnifiedSession()) throw new Error("UNIFIED_GLOBAL_MANAGEMENT_REQUIRED");
    const row = db.prepare("SELECT * FROM entity_aliases WHERE id = ? AND active = 1").get(String(id ?? ""));
    if (!row) throw new IdentityError("alias-not-found", "active alias not found");
    const recover = () => {
      const entity = entityById(row.entity_id);
      return {
        assertions: recoverPendingAssertionsForEntity(entity, row.normalized_alias, actor, evidence),
        relations: recoverPendingRelationsForEntity(entity, row.normalized_alias, actor, evidence)
      };
    };
    if (row.confirmed === 1) {
      // Already confirmed: recovery failure is surfaced, not swallowed. Pending
      // rows roll back and can be retried/selected later.
      try {
        recover();
      } catch (error) {
        throw new IdentityError(
          "pending-recovery-failed",
          "alias is already confirmed but pending assertion recovery failed; pending rows were retained",
          { cause: String(error?.message ?? error) }
        );
      }
      return toAlias(row);
    }
    const conflict = aliasConflict(row.normalized_alias, row.entity_id);
    if (conflict) {
      throw new IdentityError("alias-conflict", "confirmed alias already belongs to another entity", {
        existing_entity_id: conflict.entity_id
      });
    }
    const at = nowIso();
    const ownTransaction = !db.isTransaction;
    if (ownTransaction) db.exec("BEGIN IMMEDIATE");
    try {
      try {
        db.prepare("UPDATE entity_aliases SET confirmed = 1, updated_at = ? WHERE id = ?").run(at, row.id);
      } catch (error) {
        if (isUniqueConstraint(error)) {
          throw new IdentityError("alias-conflict", "alias was confirmed concurrently by another entity");
        }
        throw error;
      }
      appendAudit({
        event_type: "alias_confirm",
        entity_id: row.entity_id,
        actor: normalizeActor(actor),
        payload: { alias: row.alias, normalized_alias: row.normalized_alias },
        evidence: evidence ?? []
      });
      // Recover in the same transaction: if any pending attr/relation write
      // fails, the confirmation and all partial recovery writes roll back.
      recover();
      if (ownTransaction) db.exec("COMMIT");
    } catch (error) {
      if (ownTransaction) {
        try { db.exec("ROLLBACK"); } catch { /* ignore */ }
      }
      if (error?.name === "IdentityError") throw error;
      throw new IdentityError(
        "pending-recovery-failed",
        "alias confirmation rolled back because pending assertion recovery failed",
        { cause: String(error?.message ?? error) }
      );
    }
    return toAlias(db.prepare("SELECT * FROM entity_aliases WHERE id = ?").get(row.id));
  }

  function updateAlias({ id, alias, actor, evidence }) {
    if (currentUnifiedSession()) throw new Error("UNIFIED_GLOBAL_MANAGEMENT_REQUIRED");
    const row = db.prepare("SELECT * FROM entity_aliases WHERE id = ? AND active = 1").get(String(id ?? ""));
    if (!row) throw new IdentityError("alias-not-found", "active alias not found");
    const label = requireText(alias, "alias", ALIAS_MAX);
    const normalized = normalizeIdentityKey(label);
    if (normalized === row.normalized_alias) return toAlias(row);
    const at = nowIso();
    if (row.confirmed === 1) {
      const conflict = aliasConflict(normalized, row.entity_id);
      if (conflict) {
        throw new IdentityError("alias-conflict", "confirmed alias already belongs to another entity", {
          existing_entity_id: conflict.entity_id
        });
      }
    }
    if (db.prepare(
      "SELECT 1 AS x FROM entity_aliases WHERE entity_id = ? AND normalized_alias = ? AND active = 1 AND id != ?"
    ).get(row.entity_id, normalized, row.id)) {
      throw new IdentityError("alias-duplicate", "this entity already has that active alias");
    }
    db.exec("BEGIN");
    try {
      db.prepare("UPDATE entity_aliases SET active = 0, revoked_at = ?, updated_at = ? WHERE id = ?")
        .run(at, at, row.id);
      const newId = randomUUID();
      try {
        db.prepare(
          `INSERT INTO entity_aliases
             (id, entity_id, alias, normalized_alias, entity_type, provenance, confidence,
              confirmed, active, evidence, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
        ).run(
          newId, row.entity_id, label, normalized, row.entity_type ?? null, row.provenance,
          row.confidence ?? null, row.confirmed === 1 ? 1 : 0,
          evidence === undefined ? null : JSON.stringify(evidence), at, at
        );
      } catch (error) {
        if (isUniqueConstraint(error)) {
          throw new IdentityError("alias-conflict", "alias was claimed concurrently");
        }
        throw error;
      }
      db.exec("COMMIT");
      appendAudit({
        event_type: "alias_edit",
        entity_id: row.entity_id,
        actor: normalizeActor(actor),
        payload: { before: row.alias, after: label, confirmed: row.confirmed === 1 },
        evidence: evidence ?? []
      });
      return toAlias(db.prepare("SELECT * FROM entity_aliases WHERE id = ?").get(newId));
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw error;
    }
  }

  function unlinkAlias({ id, actor, evidence }) {
    if (currentUnifiedSession()) throw new Error("UNIFIED_GLOBAL_MANAGEMENT_REQUIRED");
    const row = db.prepare("SELECT * FROM entity_aliases WHERE id = ? AND active = 1").get(String(id ?? ""));
    if (!row) throw new IdentityError("alias-not-found", "active alias not found");
    const at = nowIso();
    db.prepare("UPDATE entity_aliases SET active = 0, revoked_at = ?, updated_at = ? WHERE id = ?")
      .run(at, at, row.id);
    appendAudit({
      event_type: "alias_unlink",
      entity_id: row.entity_id,
      actor: normalizeActor(actor),
      payload: { alias: row.alias, normalized_alias: row.normalized_alias, confirmed: row.confirmed === 1 },
      evidence: evidence ?? []
    });
    return toAlias(db.prepare("SELECT * FROM entity_aliases WHERE id = ?").get(row.id));
  }

  function listAliases({ entity_id, include_inactive = false } = {}) {
    if (currentUnifiedSession()) return []; // Management records have no authorized evidence view.
    const entity = entityById(String(entity_id ?? ""));
    if (!entity) return [];
    const ids = buildGroup(entity)?.member_ids ?? [entity.id];
    const placeholders = ids.map(() => "?").join(",");
    const clause = include_inactive ? "" : "AND active = 1";
    return db.prepare(
      `SELECT * FROM entity_aliases WHERE entity_id IN (${placeholders}) ${clause}
       ORDER BY active DESC, confirmed DESC, created_at, id`
    ).all(...ids).map(toAlias);
  }

  /** Record a newly observed spelling as an unconfirmed alias (never a merge). */
  function ensureObservedAlias(entity, label, actor, evidence) {
    if (currentUnifiedSession()) return;
    if (!entity || !label) return;
    const normalized = normalizeIdentityKey(label);
    if (!normalized || normalized === normalizeIdentityKey(entity.name)) return;
    try {
      createAlias({
        entity_id: entity.id,
        alias: label,
        provenance: "observed",
        confidence: 0.6,
        confirmed: false,
        actor,
        evidence
      });
    } catch (error) {
      logger?.warn?.(`[dsh-mneme] failed to record observed alias for ${entity.id}: ${String(error?.message ?? error)}`);
    }
  }

  function resolveEntityForWrite({ name, type, platform, external_id, actor = "extractor", evidence }) {
    const label = requireText(name, "name", ALIAS_MAX);
    const parsed = parseExternalIdentifiers(label);
    const requestedExternal = external_id
      ? {
          platform: platform ?? (parsed[0]?.platform ?? "manual"),
          entity_type: normalizeEntityType(type ?? (parsed[0]?.entity_type ?? "concept")),
          external_id: String(external_id)
        }
      : parsed[0] ?? null;
    const requestedType = normalizeEntityType(type ?? requestedExternal?.entity_type ?? "concept");
    const typeWasProvided = type !== undefined && type !== null && String(type).trim() !== "";
    const snapshot = loadSnapshot();

    // 1) A trusted typed identifier is authoritative. Reuse exactly its owner;
    // a *new* identifier becomes its own entity and never inherits a name or
    // nickname match (different IDs on the same platform are different people).
    if (requestedExternal) {
      if (currentUnifiedSession()) return { ok: false, reason: "global-identity-management-required", candidates: [] };
      const entityType = normalizeEntityType(requestedExternal.entity_type ?? requestedType);
      const ext = snapshot.externalIds.find((row) =>
        row.platform === requestedExternal.platform &&
        row.entity_type === entityType &&
        row.external_id === requestedExternal.external_id
      );
      if (ext) {
        const entity = snapshot.byId.get(ext.entity_id);
        if (!entity) return { ok: false, reason: "external-id-dangling", candidates: [] };
        if (entity.type && entity.type !== entityType) {
          return { ok: false, reason: "type-boundary", candidates: [buildGroup(entity, snapshot)] };
        }
        ensureObservedAlias(entity, label, actor, evidence);
        store.updateEntity(entity.id, {});
        return { ok: true, entity, canonical_id: snapshot.resolve(entity.id), created: false, matched_by: "external_id" };
      }
      // The reliable key includes entity_type, so the same numeric value can
      // legitimately identify a QQ person and a QQ group. Those are separate
      // identities; only an exact (platform, entity_type, external_id) triplet
      // is authoritative.
      const created = store.createEntity({ name: label, type: requestedType });
      createAlias({
        entity_id: created.id,
        alias: label,
        provenance: "entity_name",
        confidence: 1,
        confirmed: false,
        actor,
        evidence
      });
      try {
        linkExternalId({
          entity_id: created.id,
          platform: requestedExternal.platform,
          entity_type: entityType,
          external_id: requestedExternal.external_id,
          actor,
          source: requestedExternal.source ?? "name_parse",
          confidence: requestedExternal.confidence ?? 1,
          evidence: evidence ?? [{ kind: "extraction", value: label }]
        });
      } catch (error) {
        logger?.warn?.(`[dsh-mneme] external id link failed for ${label}: ${String(error?.message ?? error)}`);
        return { ok: false, reason: "external-id-conflict", candidates: groupsMatchingIdentity(label) };
      }
      return {
        ok: true,
        entity: created,
        canonical_id: created.id,
        created: true,
        matched_by: "new_external_id",
        name_candidates: groupsMatchingIdentity(label)
      };
    }

    const key = normalizeIdentityKey(label);
    // 2) A confirmed alias is explicit evidence; it may bind a name-only write.
    const aliasMatches = snapshot.groups.filter((group) =>
      group.aliases.some((alias) => alias.confirmed && alias.normalized_alias === key)
    );
    if (aliasMatches.length === 1) {
      const group = aliasMatches[0];
      if (group.type && group.type !== requestedType) {
        return { ok: false, reason: "type-boundary", candidates: aliasMatches };
      }
      store.updateEntity(group.id, {});
      return {
        ok: true,
        entity: snapshot.byId.get(group.id) ?? entityById(group.id),
        canonical_id: group.id,
        created: false,
        matched_by: "confirmed_alias"
      };
    }
    if (aliasMatches.length > 1) {
      return { ok: false, reason: "ambiguous-entity", candidates: aliasMatches };
    }

    // 3) Name/alias-only candidates. Person and group identities are never
    // merged by a bare nickname; unknown/null types are treated the same way.
    // Other entity types (project/concept/technology/organization) retain the
    // upstream exact-name dedupe behavior when exactly one type-compatible
    // candidate exists.
    const nameMatches = snapshot.groups.filter((group) => {
      if (normalizeIdentityKey(group.name) === key) return true;
      return group.aliases.some((alias) => alias.normalized_alias === key);
    });
    const strictType = requestedType === "person" || requestedType === "group" || !typeWasProvided;
    if (nameMatches.length) {
      if (nameMatches.length > 1) {
        return { ok: false, reason: "ambiguous-entity", candidates: nameMatches };
      }
      const group = nameMatches[0];
      if (group.type && group.type !== requestedType) {
        return { ok: false, reason: "type-boundary", candidates: [group] };
      }
      if (!strictType) {
        // Only upstream non-human types keep exact-name reuse, and only when a
        // single unambiguous candidate exists.
        store.updateEntity(group.id, {});
        ensureObservedAlias(snapshot.byId.get(group.id) ?? entityById(group.id), label, actor, evidence);
        return {
          ok: true,
          entity: snapshot.byId.get(group.id) ?? entityById(group.id),
          canonical_id: group.id,
          created: false,
          matched_by: "name"
        };
      }
      return { ok: false, reason: "name-only-unresolved", candidates: [group] };
    }

    const created = store.createEntity({ name: label, type: requestedType });
    if (!currentUnifiedSession()) createAlias({
      entity_id: created.id,
      alias: label,
      provenance: "entity_name",
      confidence: 1,
      confirmed: false,
      actor,
      evidence
    });
    return { ok: true, entity: created, canonical_id: created.id, created: true, matched_by: "new" };
  }

  function stableIdsByGroup(group) {
    const map = new Map();
    for (const ext of group.external_ids) {
      map.set(`${ext.platform}\u0000${ext.entity_type}`, ext.external_id);
    }
    return map;
  }

  function pairBlockers(left, right) {
    const blockers = [];
    if (left.type && right.type && left.type !== right.type) {
      blockers.push({ code: "type-boundary", message: `cannot link ${left.type} with ${right.type}` });
    }
    const leftIds = stableIdsByGroup(left);
    const rightIds = stableIdsByGroup(right);
    for (const [key, leftId] of leftIds) {
      const rightId = rightIds.get(key);
      if (rightId && rightId !== leftId) {
        const [platform, type] = key.split("\u0000");
        blockers.push({
          code: "conflicting-stable-ids",
          message: `different ${platform}/${type} identifiers must never be merged`,
          platform,
          entity_type: type,
          left: leftId,
          right: rightId
        });
      }
    }
    const leftConfirmed = new Set(left.aliases.filter((a) => a.confirmed).map((a) => a.normalized_alias));
    for (const alias of right.aliases) {
      if (alias.confirmed && leftConfirmed.has(alias.normalized_alias)) {
        blockers.push({ code: "alias-conflict", message: "same alias is confirmed on both entities", alias: alias.alias });
      }
    }
    return blockers;
  }

  function findDuplicateCandidates({ limit = 50, minScore = 0.72 } = {}) {
    if (currentUnifiedSession()) throw new Error("UNIFIED_GLOBAL_MANAGEMENT_REQUIRED");
    const snapshot = loadSnapshot();
    const groups = snapshot.groups;
    // Blocking keys keep candidate generation sub-quadratic. Exact name,
    // alias and typed-ID keys guarantee recall for normalized QQ-group
    // variants; bounded character-trigram blocks provide the similar-name path
    // without comparing every pair in a long-lived graph.
    const MAX_SIMILAR_BLOCK = 400;
    const blocks = new Map();
    const addKey = (key, group) => {
      if (!blocks.has(key)) blocks.set(key, []);
      const bucket = blocks.get(key);
      if (bucket[bucket.length - 1] !== group) bucket.push(group);
    };
    for (const group of groups) {
      const nameKey = normalizeIdentityKey(group.name);
      if (nameKey) addKey("name:" + nameKey, group);
      for (const alias of group.aliases) addKey("alias:" + alias.normalized_alias, group);
      for (const external of group.external_ids) {
        addKey(`ext:${external.platform}:${external.entity_type}:${external.external_id}`, group);
      }
      for (const parsed of parseExternalIdentifiers(group.name)) {
        addKey(`ext:${parsed.platform}:${parsed.entity_type}:${parsed.external_id}`, group);
      }
      const labels = new Set([group.name, ...group.aliases.map((alias) => alias.alias)]);
      for (const label of labels) {
        const normalized = normalizeIdentityKey(label);
        if (normalized.length < 3) continue;
        addKey("tri:" + normalized.slice(0, 3), group);
        addKey("tri:" + normalized.slice(-3), group);
      }
    }

    const pairs = new Map();
    const keyOf = (left, right) => (left.id < right.id ? `${left.id}|${right.id}` : `${right.id}|${left.id}`);
    const leftKeys = (group) => new Set([
      normalizeIdentityKey(group.name),
      ...group.aliases.map((alias) => alias.normalized_alias)
    ]);
    const externalKeys = (group) => {
      const keys = new Set(group.external_ids.map((ext) => `${ext.platform}\u0000${ext.entity_type}\u0000${ext.external_id}`));
      for (const ext of parseExternalIdentifiers(group.name)) {
        keys.add(`${ext.platform}\u0000${ext.entity_type}\u0000${ext.external_id}`);
      }
      return keys;
    };
    for (const [blockKey, bucket] of blocks) {
      if (bucket.length < 2) continue;
      if (blockKey.startsWith("tri:") && bucket.length > MAX_SIMILAR_BLOCK) continue;
      for (let i = 0; i < bucket.length; i++) {
        for (let j = i + 1; j < bucket.length; j++) {
          const left = bucket[i];
          const right = bucket[j];
          if (left.id === right.id) continue;
          if (left.type && right.type && left.type !== right.type) continue;
          const pairKey = keyOf(left, right);
          const existing = pairs.get(pairKey);
          const leftNameKeys = leftKeys(left);
          const rightNameKeys = leftKeys(right);
          let score = existing?.score ?? similarity(
            normalizeIdentityKey(left.name),
            normalizeIdentityKey(right.name)
          );
          const reasons = new Set(existing?.reasons ?? []);
          if (leftNameKeys.has(normalizeIdentityKey(right.name)) || rightNameKeys.has(normalizeIdentityKey(left.name))) {
            score = Math.max(score, 1);
            reasons.add("same-name");
          }
          const sharedAlias = [...leftNameKeys].find((key) => key && rightNameKeys.has(key));
          if (sharedAlias) {
            score = Math.max(score, 0.95);
            reasons.add("shared-alias");
          }
          const leftExternal = externalKeys(left);
          const rightExternal = externalKeys(right);
          if ([...leftExternal].some((key) => rightExternal.has(key))) {
            score = Math.max(score, 0.95);
            reasons.add("same-external-id");
          }
          if (score < minScore) continue;
          pairs.set(pairKey, {
            left,
            right,
            score,
            reasons: [...reasons]
          });
        }
      }
    }
    return [...pairs.values()]
      .map((pair) => {
        const blockers = pairBlockers(pair.left, pair.right);
        if (blockers.some((b) => b.code === "conflicting-stable-ids")) return null;
        return {
          ...pair,
          score: Number(pair.score.toFixed(3)),
          reasons: pair.reasons.length ? pair.reasons.sort() : ["similar-name"],
          blocked: blockers.length > 0,
          blockers,
          requires_confirmation: true
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || a.left.name.localeCompare(b.left.name))
      .slice(0, Math.max(1, Math.min(500, limit)));
  }

  function collectGroupRows(group) {
    const ids = group.member_ids;
    const placeholders = ids.map(() => "?").join(",");
    const attrs = db.prepare(
      `SELECT * FROM entity_attrs WHERE entity_id IN (${placeholders}) ORDER BY entity_id, attr_key, valid_from`
    ).all(...ids);
    const relations = db.prepare(
      `SELECT * FROM entity_relations WHERE from_entity IN (${placeholders}) OR to_entity IN (${placeholders})`
    ).all(...ids, ...ids);
    const memoryIds = new Set();
    for (const attr of attrs) if (attr.memory_id) memoryIds.add(attr.memory_id);
    for (const rel of relations) if (rel.memory_id) memoryIds.add(rel.memory_id);
    return { ids, attrs, relations, memoryIds: [...memoryIds] };
  }

  function impactReport({ from_entity, to_entity }) {
    if (currentUnifiedSession()) throw new Error("UNIFIED_GLOBAL_MANAGEMENT_REQUIRED");
    const snapshot = loadSnapshot();
    const fromRaw = snapshot.byId.get(String(from_entity ?? "")) ?? entityById(String(from_entity ?? ""));
    const toRaw = snapshot.byId.get(String(to_entity ?? "")) ?? entityById(String(to_entity ?? ""));
    if (!fromRaw || !toRaw) throw new IdentityError("entity-not-found", "both entities must exist");
    const from = buildGroup(fromRaw, snapshot);
    const to = buildGroup(toRaw, snapshot);
    if (from.id === to.id) throw new IdentityError("same-entity", "cannot link an entity to itself");
    const blockers = pairBlockers(from, to);
    // Also reject a transitive cycle: linking from -> to is invalid when to
    // already resolves through from.
    if (snapshot.resolve(to.id) === from.id) {
      blockers.push({ code: "cycle", message: "linking would create a canonical cycle" });
    }
    const fromRows = collectGroupRows(from);
    const toRows = collectGroupRows(to);
    const toCurrent = new Map();
    for (const attr of toRows.attrs) {
      if (attr.valid_until === null && attr.valid_until !== undefined) {
        toCurrent.set(attr.attr_key, attr.attr_value);
      }
    }
    const attrConflicts = [];
    for (const attr of fromRows.attrs) {
      if (attr.valid_until !== null && attr.valid_until !== undefined) continue;
      const other = toCurrent.get(attr.attr_key);
      if (other !== undefined && other !== attr.attr_value) {
        attrConflicts.push({ key: attr.attr_key, from_value: attr.attr_value, to_value: other, memory_id: attr.memory_id ?? null });
      }
    }
    const relationKeys = new Map();
    for (const rel of toRows.relations) {
      const key = `${snapshot.resolve(rel.from_entity)}\u0000${snapshot.resolve(rel.to_entity)}\u0000${rel.relation_type}`;
      if (!relationKeys.has(key)) relationKeys.set(key, []);
      relationKeys.get(key).push(rel.id);
    }
    const relationDuplicates = [];
    for (const rel of fromRows.relations) {
      const key = `${snapshot.resolve(rel.from_entity)}\u0000${snapshot.resolve(rel.to_entity)}\u0000${rel.relation_type}`;
      if (relationKeys.has(key)) relationDuplicates.push({ key, edge_id: rel.id, existing_edges: relationKeys.get(key) });
    }
    const allMemories = [...new Set([...fromRows.memoryIds, ...toRows.memoryIds])];
    const missingMemories = allMemories.filter((id) => !store.getById(id));
    const memberIds = [...new Set([...from.member_ids, ...to.member_ids])];
    const memberSet = new Set(memberIds);
    const aliases = memberIds.flatMap((id) => snapshot.aliasesByEntity.get(id) ?? [])
      .map((alias) => ({
        id: alias.id, entity_id: alias.entity_id, alias: alias.alias,
        normalized_alias: alias.normalized_alias, entity_type: alias.entity_type,
        provenance: alias.provenance, confidence: alias.confidence,
        confirmed: alias.confirmed, evidence: alias.evidence,
        created_at: alias.created_at, updated_at: alias.updated_at
      }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const externalIds = memberIds.flatMap((id) => snapshot.externalByEntity.get(id) ?? [])
      .map((external) => ({
        id: external.id, entity_id: external.entity_id, platform: external.platform,
        entity_type: external.entity_type, external_id: external.external_id,
        status: external.status, source: external.source, confidence: external.confidence,
        evidence: external.evidence, created_at: external.created_at, updated_at: external.updated_at
      }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const links = snapshot.links.filter((link) =>
      memberSet.has(link.entity_id) || memberSet.has(link.canonical_id)
    ).map((link) => ({
      id: link.id, entity_id: link.entity_id, canonical_id: link.canonical_id,
      source: link.source, linked_at: link.linked_at
    })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const attrs = [...fromRows.attrs, ...toRows.attrs].map((attr) => ({
      id: attr.id, entity_id: attr.entity_id, attr_key: attr.attr_key,
      attr_value: attr.attr_value, memory_id: attr.memory_id ?? null,
      valid_from: attr.valid_from, valid_until: attr.valid_until ?? null,
      confidence: attr.confidence ?? null, source: attr.source ?? null
    })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const relations = [...fromRows.relations, ...toRows.relations].map((rel) => ({
      id: rel.id, from_entity: rel.from_entity, to_entity: rel.to_entity,
      relation_type: rel.relation_type, memory_id: rel.memory_id ?? null,
      created_at: rel.created_at, metadata: rel.metadata ?? null,
      weight: rel.weight ?? 1, source: rel.source ?? "manual"
    })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const sortedBlockers = [...blockers].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b))
    );
    const sortedAttrConflicts = [...attrConflicts].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b))
    );
    const sortedRelationDuplicates = [...relationDuplicates].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b))
    );
    const counts = {
      entities: from.member_ids.length,
      attrs_linked: fromRows.attrs.length,
      attrs_current: fromRows.attrs.filter((a) => a.valid_until === null || a.valid_until === undefined).length,
      relations_linked: fromRows.relations.length,
      memories_linked: fromRows.memoryIds.length,
      total_memories_after: allMemories.length,
      attr_conflicts: attrConflicts.length,
      relation_duplicates: relationDuplicates.length,
      missing_memories: missingMemories.length
    };
    // Deterministic fingerprint of every material input: same counts are not
    // enough (an attr value or relation weight can change without changing the
    // row count).
    const fingerprint = createHash("sha256").update(JSON.stringify({
      from: { id: from.id, type: from.type, member_ids: from.member_ids },
      to: { id: to.id, type: to.type, member_ids: to.member_ids },
      counts,
      blockers: sortedBlockers,
      attr_conflicts: sortedAttrConflicts,
      relation_duplicates: sortedRelationDuplicates,
      missing_memories: [...missingMemories].sort(),
      attrs,
      relations,
      aliases,
      external_ids: externalIds,
      links
    })).digest("hex");
    return {
      from: { id: from.id, name: from.name, type: from.type, member_ids: from.member_ids },
      to: { id: to.id, name: to.name, type: to.type, member_ids: to.member_ids },
      counts,
      conflicts: {
        attr: attrConflicts,
        relation_duplicates: relationDuplicates,
        missing_memories: missingMemories
      },
      blocked: blockers.length > 0,
      blockers,
      fingerprint
    };
  }

  function dryRunMerge({ from_entity, to_entity, actor, evidence }) {
    if (currentUnifiedSession()) throw new Error("UNIFIED_GLOBAL_MANAGEMENT_REQUIRED");
    const report = impactReport({ from_entity, to_entity });
    const id = randomUUID();
    const at = nowIso();
    const payload = { ...report, report_id: id, generated_at: at, applied: false };
    db.prepare(
      `INSERT INTO entity_merge_reports (id, from_entity, to_entity, report, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, String(from_entity), String(to_entity), JSON.stringify(payload), at, normalizeActor(actor));
    appendAudit({
      event_type: "merge_dry_run",
      entity_id: String(from_entity),
      related_entity_id: String(to_entity),
      actor: normalizeActor(actor),
      payload: { report_id: id, counts: report.counts, blocked: report.blocked },
      evidence: evidence ?? []
    });
    return { ...payload, report_id: id };
  }

  function confirmMerge({ report_id, actor, evidence }) {
    if (currentUnifiedSession()) throw new Error("UNIFIED_GLOBAL_MANAGEMENT_REQUIRED");
    const id = String(report_id ?? "");
    const initial = db.prepare("SELECT * FROM entity_merge_reports WHERE id = ?").get(id);
    if (!initial) throw new IdentityError("report-not-found", "merge report not found");
    // BEGIN IMMEDIATE takes the SQLite write lock before re-evaluating the
    // fingerprint, so no other writer can change attributes, relations,
    // aliases, external IDs or links between the check and the link insert.
    let row;
    let fresh;
    let linkId;
    db.exec("BEGIN IMMEDIATE");
    try {
      row = db.prepare("SELECT * FROM entity_merge_reports WHERE id = ?").get(id);
      if (!row) throw new IdentityError("report-not-found", "merge report not found");
      if (row.undone_at) throw new IdentityError("report-undone", "merge report was already undone");
      if (row.applied_at) throw new IdentityError("report-applied", "merge report was already applied");
      const saved = parseJson(row.report, {});
      fresh = impactReport({ from_entity: row.from_entity, to_entity: row.to_entity });
      if (fresh.from.id !== saved.from?.id || fresh.to.id !== saved.to?.id) {
        throw new IdentityError("stale-report", "canonical target changed since the dry run; generate a new report", {
          current_from: fresh.from.id,
          current_to: fresh.to.id
        });
      }
      if (!saved.fingerprint || fresh.fingerprint !== saved.fingerprint) {
        throw new IdentityError(
          "stale-report",
          "merge inputs changed since the dry run; generate a new impact report",
          { report_fingerprint: saved.fingerprint ?? null, current_fingerprint: fresh.fingerprint }
        );
      }
      if (fresh.blocked) {
        throw new IdentityError("merge-blocked", "merge has unresolved blockers", { blockers: fresh.blockers });
      }
      const from = entityById(row.from_entity);
      const to = entityById(row.to_entity);
      if (!from || !to) throw new IdentityError("entity-not-found", "both entities must exist");
      if (db.prepare("SELECT 1 AS x FROM entity_canonical_links WHERE entity_id = ? AND active = 1").get(from.id)) {
        throw new IdentityError("already-linked", "source entity is already linked");
      }
      const at = nowIso();
      linkId = randomUUID();
      // Everything below is additive. No entity/attr/relation/memory row is
      // rewritten or deleted; the view alone changes.
      try {
        db.prepare(
          `INSERT INTO entity_canonical_links
             (id, entity_id, canonical_id, active, source, evidence, linked_at, linked_by)
           VALUES (?, ?, ?, 1, 'merge', ?, ?, ?)`
        ).run(linkId, from.id, to.id, evidence === undefined ? null : JSON.stringify(evidence), at, normalizeActor(actor));
      } catch (error) {
        if (isUniqueConstraint(error)) {
          throw new IdentityError("already-linked", "source entity was linked concurrently");
        }
        throw error;
      }
      db.prepare(
        "UPDATE entity_merge_reports SET applied_at = ?, applied_link_id = ? WHERE id = ?"
      ).run(at, linkId, row.id);
      appendAudit({
        event_type: "merge_confirm",
        entity_id: from.id,
        related_entity_id: to.id,
        actor: normalizeActor(actor),
        payload: {
          report_id: row.id,
          link_id: linkId,
          counts: fresh.counts,
          fingerprint: fresh.fingerprint
        },
        evidence: evidence ?? []
      });
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw error;
    }
    return {
      report_id: row.id,
      link: toLink(db.prepare("SELECT * FROM entity_canonical_links WHERE id = ?").get(linkId)),
      canonical: buildGroup(entityById(fresh.to.id))
    };
  }

  function undoMerge({ link_id, report_id, actor, evidence }) {
    if (currentUnifiedSession()) throw new Error("UNIFIED_GLOBAL_MANAGEMENT_REQUIRED");
    const link = link_id
      ? db.prepare("SELECT * FROM entity_canonical_links WHERE id = ? AND active = 1").get(String(link_id))
      : db.prepare(
          "SELECT l.* FROM entity_canonical_links l JOIN entity_merge_reports r ON r.applied_link_id = l.id WHERE r.id = ? AND l.active = 1"
        ).get(String(report_id ?? ""));
    if (!link) throw new IdentityError("link-not-found", "active canonical link not found");
    const dependents = db.prepare(
      "SELECT id FROM entity_canonical_links WHERE canonical_id = ? AND active = 1 AND id != ?"
    ).all(link.entity_id, link.id);
    if (dependents.length) {
      throw new IdentityError("has-dependents", "undo dependent merges first", {
        dependent_link_ids: dependents.map((row) => row.id)
      });
    }
    const at = nowIso();
    db.exec("BEGIN");
    try {
      db.prepare(
        "UPDATE entity_canonical_links SET active = 0, undone_at = ?, undone_by = ? WHERE id = ?"
      ).run(at, normalizeActor(actor), link.id);
      db.prepare(
        "UPDATE entity_merge_reports SET undone_at = ?, undone_by = ? WHERE applied_link_id = ?"
      ).run(at, normalizeActor(actor), link.id);
      appendAudit({
        event_type: "merge_undo",
        entity_id: link.entity_id,
        related_entity_id: link.canonical_id,
        actor: normalizeActor(actor),
        payload: { link_id: link.id },
        evidence: evidence ?? []
      });
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw error;
    }
    return {
      link: toLink(db.prepare("SELECT * FROM entity_canonical_links WHERE id = ?").get(link.id)),
      restored: buildGroup(entityById(link.entity_id))
    };
  }

  function listLinks({ include_inactive = false, limit = 200 } = {}) {
    if (currentUnifiedSession()) return []; // Management records have no authorized evidence view.
    const clause = include_inactive ? "" : "WHERE active = 1";
    return db.prepare(
      `SELECT * FROM entity_canonical_links ${clause} ORDER BY linked_at DESC, id DESC LIMIT ?`
    ).all(Math.max(1, Math.min(1000, limit))).map(toLink);
  }

  function history({ entity_id, limit = 100 } = {}) {
    if (currentUnifiedSession()) throw new Error("UNIFIED_GLOBAL_MANAGEMENT_REQUIRED");
    const entity = entityById(String(entity_id ?? ""));
    if (!entity) throw new IdentityError("entity-not-found", "entity not found");
    const group = buildGroup(entity);
    const placeholders = group.member_ids.map(() => "?").join(",");
    const events = db.prepare(
      `SELECT * FROM identity_audit_events
       WHERE entity_id IN (${placeholders}) OR related_entity_id IN (${placeholders})
       ORDER BY created_at DESC, id DESC LIMIT ?`
    ).all(...group.member_ids, ...group.member_ids, Math.max(1, Math.min(500, limit))).map((row) => ({
      id: row.id,
      event_type: row.event_type,
      entity_id: row.entity_id,
      related_entity_id: row.related_entity_id,
      actor: row.actor,
      payload: parseJson(row.payload, {}),
      evidence: parseJson(row.evidence, []),
      created_at: row.created_at
    }));
    return {
      group,
      aliases: listAliases({ entity_id: entity.id, include_inactive: true }),
      external_ids: listExternalIds({ entity_id: entity.id, include_revoked: true }),
      links: listLinks({ include_inactive: true, limit: 200 }).filter(
        (link) => group.member_ids.includes(link.entity_id) || group.member_ids.includes(link.canonical_id)
      ),
      events
    };
  }

  function resolveForSearch(raw) {
    const groups = groupsMatchingIdentity(raw);
    return { groups, ambiguous: groups.length > 1 };
  }

  function entityIdsForMemory(memoryId) {
    if (!memoryId) return [];
    const rows = db.prepare(
      `SELECT DISTINCT entity_id FROM entity_attrs WHERE memory_id = ?
       UNION
       SELECT DISTINCT from_entity AS entity_id FROM entity_relations WHERE memory_id = ?
       UNION
       SELECT DISTINCT to_entity AS entity_id FROM entity_relations WHERE memory_id = ?`
    ).all(memoryId, memoryId, memoryId);
    return rows.map((row) => row.entity_id);
  }

  function canonicalEntityIdsForMemory(memoryId, snapshot = null) {
    const resolve = snapshot ? (id) => snapshot.resolve(id) : canonicalIdOf;
    return [...new Set(entityIdsForMemory(memoryId).map(resolve))];
  }

  function groupsForEntityIds(entityIds) {
    const snapshot = loadSnapshot();
    return [...new Set(entityIds.map((id) => snapshot.resolve(id)))]
      .map((id) => buildGroup(snapshot.byId.get(id), snapshot))
      .filter(Boolean);
  }

  function groupForEntity(entityId) {
    const snapshot = loadSnapshot();
    const entity = snapshot.byId.get(String(entityId ?? ""));
    return entity ? buildGroup(entity, snapshot) : null;
  }

  function snapshotStats() {
    return loadSnapshot().stats;
  }

  return {
    schema: IDENTITY_SCHEMA,
    appendAudit,
    canonicalIdOf,
    buildGroup,
    groupForEntity,
    allGroups,
    listEntities,
    listEntitiesPage,
    snapshotStats,
    readSnapshot: loadSnapshot,
    lastSnapshotStats: () => currentUnifiedSession() ? loadSnapshot().stats : lastSnapshotStats,
    groupsMatchingIdentity,
    groupsMatchingPublicIdentity,
    resolveForSearch,
    resolveAlias,
    findEntitiesMentionedIn,
    canonicalizeEntityRows,
    canonicalizeRelations,
    canonicalizeNeighbors,
    linkedMemoryIds,
    neighborsOf,
    createAlias,
    confirmAlias,
    updateAlias,
    unlinkAlias,
    listAliases,
    linkExternalId,
    listExternalIds,
    unlinkExternalId,
    resolveEntityForWrite,
    parseExternalIdentifiers,
    findDuplicateCandidates,
    impactReport,
    dryRunMerge,
    confirmMerge,
    undoMerge,
    listLinks,
    history,
    recordPendingAssertion,
    listPendingAssertions,
    resolvePendingAssertion,
    recoverPendingAssertionsForEntity,
    recordPendingRelation,
    listPendingRelations,
    recoverPendingRelationsForEntity,
    entityIdsForMemory,
    canonicalEntityIdsForMemory,
    relationsForEntity,
    groupsForEntityIds
  };
}
