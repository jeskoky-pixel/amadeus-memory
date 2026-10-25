// Memory preference weights for the Amadeus memory enhancer.
//
// Automatic importance (1-5) is never touched. Preferences are an opt-in,
// bounded signal layered on top of recall:
//   weight range      0.5 .. 2.0 (validated on write)
//   combination       geometric product over every matched tag weight and every
//                     matched canonical-entity weight (each canonical entity
//                     contributes at most once, using the strongest member)
//   clamp             final factor is clamped to 0.6 .. 1.6
//   relevance floor   a candidate is only reranked when its fused relevance is
//                     at least 65% of the best candidate's relevance, so an
//                     unrelated high-weight memory cannot outrank a relevant one
// When the flag is off, or every stored weight is exactly 1.0, no ranking code
// path changes at all.
import { randomUUID } from "node:crypto";
import { eventTagForKind, normalizeEventTag } from "./trusted-events.js";

export const PREFERENCE_WEIGHT_MIN = 0.5;
export const PREFERENCE_WEIGHT_MAX = 2.0;
export const PREFERENCE_WEIGHT_DEFAULT = 1.0;
export const PREFERENCE_FACTOR_MIN = 0.6;
export const PREFERENCE_FACTOR_MAX = 1.6;
export const PREFERENCE_RELEVANCE_FLOOR = 0.65;

export const PREFERENCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS tag_weights (
  tag        TEXT PRIMARY KEY,
  weight     REAL NOT NULL DEFAULT 1.0
             CHECK (weight >= 0.5 AND weight <= 2.0),
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
CREATE TABLE IF NOT EXISTS entity_preference_weights (
  entity_id  TEXT PRIMARY KEY,
  weight     REAL NOT NULL DEFAULT 1.0
             CHECK (weight >= 0.5 AND weight <= 2.0),
  updated_at TEXT NOT NULL,
  updated_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_entity_pref_weight ON entity_preference_weights(weight);
`;

function nowIso() {
  return new Date().toISOString();
}

function normalizeActor(actor) {
  const text = String(actor ?? "").trim();
  return text ? text.slice(0, 200) : "unknown";
}

export function normalizePreferenceTag(tag) {
  return String(tag ?? "").normalize("NFKC").trim().toLowerCase().replace(/\s+/g, "-");
}

function validateWeight(weight) {
  const value = Number(weight);
  if (!Number.isFinite(value) || value < PREFERENCE_WEIGHT_MIN || value > PREFERENCE_WEIGHT_MAX) {
    throw new PreferenceError(
      "invalid-weight",
      `weight must be a number in [${PREFERENCE_WEIGHT_MIN}, ${PREFERENCE_WEIGHT_MAX}]`
    );
  }
  return value;
}

export class PreferenceError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "PreferenceError";
    this.code = code;
    this.details = details;
  }
}

function toWeightRow(row) {
  return {
    key: row.tag ?? row.entity_id,
    tag: row.tag,
    entity_id: row.entity_id,
    weight: Number(row.weight),
    updated_at: row.updated_at,
    updated_by: row.updated_by ?? null
  };
}

export function createPreferenceService({ db, store, identity, config } = {}) {
  if (!db || !store || !identity) throw new Error("createPreferenceService: db, store and identity are required");
  db.exec(PREFERENCE_SCHEMA);

  function audit(eventType, payload, actor) {
    try {
      identity.appendAudit({
        event_type: eventType,
        actor: normalizeActor(actor),
        payload
      });
    } catch { /* preference writes are not allowed to fail because audit failed */ }
  }

  function listTagWeights() {
    return db.prepare("SELECT * FROM tag_weights ORDER BY tag").all().map(toWeightRow);
  }

  function listEntityWeights() {
    const rows = db.prepare("SELECT * FROM entity_preference_weights ORDER BY updated_at DESC, entity_id").all();
    // One row per canonical group (strongest member), so a pre-merge weight on
    // a member does not appear as a second "entity" in the panel.
    const byCanonical = new Map();
    for (const row of rows) {
      const group = identity.groupForEntity(row.entity_id);
      const canonical = group?.id ?? row.entity_id;
      const current = byCanonical.get(canonical);
      if (!current || Number(row.weight) > Number(current.weight)) {
        byCanonical.set(canonical, {
          ...toWeightRow(row),
          entity_id: canonical,
          canonical_id: canonical,
          name: group?.name ?? canonical,
          type: group?.type ?? null,
          merged: group?.merged ?? false
        });
      }
    }
    return [...byCanonical.values()];
  }

  function setTagWeight({ tag, weight, actor }) {
    const key = normalizePreferenceTag(tag);
    if (!key || key.length > 64) throw new PreferenceError("invalid-tag", "tag must be 1-64 characters");
    const value = validateWeight(weight);
    db.prepare(
      `INSERT INTO tag_weights (tag, weight, updated_at, updated_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(tag) DO UPDATE SET
         weight = excluded.weight, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
    ).run(key, value, nowIso(), normalizeActor(actor));
    audit("preference_tag_set", { tag: key, weight: value }, actor);
    return { ...toWeightRow(db.prepare("SELECT * FROM tag_weights WHERE tag = ?").get(key)) };
  }

  function deleteTagWeight({ tag, actor }) {
    const key = normalizePreferenceTag(tag);
    const info = db.prepare("DELETE FROM tag_weights WHERE tag = ?").run(key);
    if (info.changes > 0) audit("preference_tag_delete", { tag: key }, actor);
    return info.changes > 0;
  }

  function setEntityWeight({ entity_id, weight, actor }) {
    const group = identity.groupForEntity(String(entity_id ?? ""));
    if (!group) throw new PreferenceError("entity-not-found", "entity not found");
    const value = validateWeight(weight);
    const at = nowIso();
    db.exec("BEGIN");
    try {
      // One weight per canonical group: clear legacy member rows so an explicit
      // set (including a lower value) is not silently overridden by an older
      // member's higher weight.
      const placeholders = group.member_ids.map(() => "?").join(",");
      db.prepare(`DELETE FROM entity_preference_weights WHERE entity_id IN (${placeholders})`)
        .run(...group.member_ids);
      db.prepare(
        `INSERT INTO entity_preference_weights (entity_id, weight, updated_at, updated_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(entity_id) DO UPDATE SET
           weight = excluded.weight, updated_at = excluded.updated_at, updated_by = excluded.updated_by`
      ).run(group.id, value, at, normalizeActor(actor));
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw error;
    }
    audit("preference_entity_set", { entity_id: group.id, weight: value }, actor);
    const row = db.prepare("SELECT * FROM entity_preference_weights WHERE entity_id = ?").get(group.id);
    return {
      ...toWeightRow(row),
      canonical_id: group.id,
      name: group.name,
      type: group.type,
      merged: group.merged
    };
  }

  function deleteEntityWeight({ entity_id, actor }) {
    const group = identity.groupForEntity(String(entity_id ?? ""));
    if (!group) return false;
    const placeholders = group.member_ids.map(() => "?").join(",");
    const info = db.prepare(
      `DELETE FROM entity_preference_weights WHERE entity_id IN (${placeholders})`
    ).run(...group.member_ids);
    if (info.changes > 0) audit("preference_entity_delete", { entity_id: group.id }, actor);
    return info.changes > 0;
  }

  function getState() {
    return {
      enabled: config?.memoryPreferenceEnabled === true,
      weight_min: PREFERENCE_WEIGHT_MIN,
      weight_max: PREFERENCE_WEIGHT_MAX,
      default_weight: PREFERENCE_WEIGHT_DEFAULT,
      factor_min: PREFERENCE_FACTOR_MIN,
      factor_max: PREFERENCE_FACTOR_MAX,
      relevance_floor: PREFERENCE_RELEVANCE_FLOOR,
      tags: listTagWeights(),
      entities: listEntityWeights()
    };
  }

  function tagWeightMap() {
    const map = new Map();
    for (const row of db.prepare("SELECT tag, weight FROM tag_weights").all()) {
      map.set(row.tag, Number(row.weight));
    }
    return map;
  }

  function entityWeightsByCanonical() {
    const rows = db.prepare("SELECT entity_id, weight FROM entity_preference_weights").all();
    if (!rows.length) return new Map();
    const map = new Map();
    for (const row of rows) {
      const canonical = identity.canonicalIdOf(row.entity_id);
      const current = map.get(canonical);
      const weight = Number(row.weight);
      if (current === undefined || weight > current) map.set(canonical, weight);
    }
    return map;
  }

  function hasNonDefaultWeights() {
    const tag = db.prepare("SELECT 1 AS x FROM tag_weights WHERE weight != 1.0 LIMIT 1").get();
    if (tag) return true;
    return Boolean(db.prepare("SELECT 1 AS x FROM entity_preference_weights WHERE weight != 1.0 LIMIT 1").get());
  }

  /**
   * Build one scorer for a retrieval scene. Returns factorFor(row) and
   * annotate(row); `active` is false when the flag is off or every stored
   * weight is exactly 1.0, in which case callers must stay on the legacy path.
   */
  function createScorer() {
    const active = config?.memoryPreferenceEnabled === true && hasNonDefaultWeights();
    if (!active) {
      const inert = {
        active: false,
        factorFor: () => ({ factor: 1, applied: false, clamped: false, tags: [], entities: [] }),
        annotate: (row) => row
      };
      return inert;
    }
    const tags = tagWeightMap();
    const entityWeights = entityWeightsByCanonical();
    const snapshot = identity.readSnapshot?.() ?? null;
    const groupCache = new Map();
    const groupOf = (id) => {
      if (!groupCache.has(id)) groupCache.set(id, identity.groupForEntity(id));
      return groupCache.get(id);
    };
    const memoryEntityCache = new Map();
    const memoryCanonicalIds = (memoryId) => {
      if (!memoryId) return [];
      if (!memoryEntityCache.has(memoryId)) {
        memoryEntityCache.set(memoryId, identity.canonicalEntityIdsForMemory(memoryId, snapshot));
      }
      return memoryEntityCache.get(memoryId);
    };
    const provenEventTagsCache = new Map();
    const provenEventTags = (memoryId) => {
      if (!memoryId) return new Set();
      if (!provenEventTagsCache.has(memoryId)) {
        const rows = db.prepare(
          "SELECT DISTINCT kind FROM memory_trusted_provenance WHERE memory_id = ?"
        ).all(memoryId);
        provenEventTagsCache.set(memoryId, new Set(
          rows.map((row) => eventTagForKind(row.kind)).filter(Boolean)
        ));
      }
      return provenEventTagsCache.get(memoryId);
    };

    function factorFor(row) {
      const tagHits = [];
      let raw = 1;
      const rowTags = Array.isArray(row?.tags) ? row.tags : [];
      for (const tag of rowTags) {
        // Event claims are authority-bearing: old spoofed/Unicode tags in an
        // existing DB must not earn a trusted-event preference unless committed
        // provenance backs that exact kind for this memory.
        const eventTag = normalizeEventTag(tag);
        if (eventTag && !provenEventTags(row?.id).has(eventTag)) continue;
        const key = normalizePreferenceTag(tag);
        const weight = tags.get(key);
        if (weight === undefined) continue;
        tagHits.push({ tag: key, weight });
        raw *= weight;
      }
      const entityHits = [];
      for (const id of memoryCanonicalIds(row?.id)) {
        const weight = entityWeights.get(id);
        if (weight === undefined) continue;
        const group = groupOf(id);
        entityHits.push({ entity_id: id, name: group?.name ?? id, weight });
        raw *= weight;
      }
      const factor = Math.min(PREFERENCE_FACTOR_MAX, Math.max(PREFERENCE_FACTOR_MIN, raw));
      const applied = tagHits.some((hit) => hit.weight !== 1) || entityHits.some((hit) => hit.weight !== 1);
      return {
        factor: applied ? factor : 1,
        raw: Number(raw.toFixed(6)),
        clamped: raw < PREFERENCE_FACTOR_MIN || raw > PREFERENCE_FACTOR_MAX,
        applied,
        tags: tagHits,
        entities: entityHits
      };
    }

    function annotate(row) {
      const preference = factorFor(row);
      if (!preference.applied) return row;
      const out = { ...row, preference: { ...preference, score: row.score ?? row._score ?? null } };
      if (out.signals && typeof out.signals === "object") {
        out.signals = {
          ...out.signals,
          preference: {
            factor: preference.factor,
            clamped: preference.clamped,
            tags: preference.tags,
            entities: preference.entities
          }
        };
      }
      return out;
    }

    return { active: true, factorFor, annotate };
  }

  /**
   * Rerank fused retrieval rows before the final topK cut. Caller passes the
   * (already scope/archive/forget/time filtered) pool. Rows below the
   * relevance floor keep their original score; the factor is bounded, so a
   * high-weight unrelated row cannot cross a genuinely relevant one.
   */
  function rerankRows(rows, { scorer, scoreKey = "score", lim = 20, relevanceFloor = PREFERENCE_RELEVANCE_FLOOR } = {}) {
    if (!Array.isArray(rows) || !rows.length) return rows;
    const scorerObj = scorer ?? createScorer();
    if (!scorerObj.active) return rows;
    const infos = new Map();
    let anyApplied = false;
    for (const row of rows) {
      const info = scorerObj.factorFor(row);
      infos.set(row.id, info);
      if (info.applied) anyApplied = true;
    }
    if (!anyApplied) return rows;
    const scoreOf = (row) => Number(row?.[scoreKey] ?? row?.score ?? 0);
    let top = 0;
    for (const row of rows) top = Math.max(top, scoreOf(row));
    const floorScore = top > 0 ? top * relevanceFloor : 0;
    const decorated = rows.map((row) => {
      const info = infos.get(row.id);
      const base = scoreOf(row);
      const eligible = info?.applied && base >= floorScore;
      const adjusted = eligible ? base * info.factor : base;
      return { row, info, eligible, adjusted, base };
    });
    decorated.sort((a, b) => b.adjusted - a.adjusted || b.base - a.base);
    return decorated.slice(0, lim).map(({ row, info, eligible }) => {
      if (!info?.applied) return row;
      const out = {
        ...row,
        preference: {
          ...info,
          eligible,
          score: row[scoreKey] ?? row.score ?? null
        }
      };
      if (out.signals && typeof out.signals === "object") {
        out.signals = {
          ...out.signals,
          preference: {
            factor: info.factor,
            clamped: info.clamped,
            eligible,
            tags: info.tags,
            entities: info.entities
          }
        };
      }
      return out;
    });
  }

  return {
    schema: PREFERENCE_SCHEMA,
    listTagWeights,
    listEntityWeights,
    setTagWeight,
    deleteTagWeight,
    setEntityWeight,
    deleteEntityWeight,
    getState,
    hasNonDefaultWeights,
    createScorer,
    rerankRows
  };
}
