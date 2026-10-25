// Trusted own-experience intake for the Amadeus memory enhancer.
//
// This is deliberately a *small structured interface*, not a free-form chat
// extractor: the caller (Life) must state source, actor, participation and
// status explicitly. Only this path derives event:* tags; an LLM reading casual
// chat can never invent that a planned action was completed.
import { createHash, randomUUID } from "node:crypto";
import { scopeKeyOf, normalizeExplicitScope } from "./scope.js";
import { eventTagForKind, isEventTag } from "./trusted-events.js";

export const TRUSTED_INTAKE_KINDS = Object.freeze([
  "self_action", "direct_interaction", "reported_by_other", "observation"
]);
export const TRUSTED_INTAKE_STATUSES = Object.freeze(["completed", "reported"]);
export const TRUSTED_INTAKE_SOURCES = Object.freeze(["verified_user", "trusted_contact", "system"]);
export const TRUSTED_INTAKE_PARTICIPATION = Object.freeze(["agent", "user", "both", "observed", "none"]);

const KIND_SET = new Set(TRUSTED_INTAKE_KINDS);
const STATUS_SET = new Set(TRUSTED_INTAKE_STATUSES);
const SOURCE_SET = new Set(TRUSTED_INTAKE_SOURCES);
const PARTICIPATION_SET = new Set(TRUSTED_INTAKE_PARTICIPATION);
const INTAKE_TYPES = new Set([
  "preference", "project", "decision", "history", "summary", "pattern",
  "rejected_solution", "pitfall", "constraint"
]);
// kind -> allowed participation / trust source. These are structural, not
// advisory: a self action cannot claim it was merely observed, and a report
// cannot claim the reporting agent performed it.
const KIND_RULES = {
  self_action: { participation: new Set(["agent", "both"]), source: new Set(["system", "verified_user"]) },
  direct_interaction: { participation: new Set(["both", "user"]), source: new Set(["verified_user", "system"]) },
  reported_by_other: { participation: new Set(["none", "observed", "user"]), source: new Set(["trusted_contact"]) },
  observation: { participation: new Set(["observed", "none"]), source: new Set(["system"]) }
};

export const INTAKE_SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_trusted_provenance (
  id              TEXT PRIMARY KEY,
  memory_id       TEXT NOT NULL,
  kind            TEXT NOT NULL,
  actor           TEXT NOT NULL,
  participation   TEXT NOT NULL,
  trust_source    TEXT NOT NULL,
  status          TEXT NOT NULL,
  occurred_at     TEXT,
  agent_scope     TEXT,
  workspace_scope TEXT,
  evidence        TEXT,
  request_id      TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trusted_provenance_memory ON memory_trusted_provenance(memory_id);
CREATE INDEX IF NOT EXISTS idx_trusted_provenance_kind ON memory_trusted_provenance(kind, created_at);
-- Durable request-id idempotency. Additive table only: old databases may have
-- duplicate historical request_id values in memory_trusted_provenance, so no
-- unique index is added there. The request_key is the atomic idempotency key.
CREATE TABLE IF NOT EXISTS memory_trusted_requests (
  request_key   TEXT PRIMARY KEY,
  request_id    TEXT NOT NULL,
  actor_key     TEXT NOT NULL,
  fingerprint   TEXT NOT NULL,
  memory_id     TEXT NOT NULL,
  provenance_id TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trusted_requests_actor ON memory_trusted_requests(actor_key, created_at);
`;

export class IntakeError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "IntakeError";
    this.code = code;
    this.details = details;
  }
}

function requireText(value, field, max) {
  const text = String(value ?? "").normalize("NFKC").trim();
  if (!text) throw new IntakeError("invalid-" + field, `${field} must be a non-empty string`);
  if (text.length > max) throw new IntakeError("invalid-" + field, `${field} exceeds ${max} characters`);
  return text;
}

function optionalText(value, field, max) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).normalize("NFKC").trim();
  if (!text) return undefined;
  if (text.length > max) throw new IntakeError("invalid-" + field, `${field} exceeds ${max} characters`);
  return text;
}

function normalizeEvidence(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new IntakeError("invalid-evidence", "evidence must be an array");
  if (raw.length > 20) throw new IntakeError("invalid-evidence", "evidence may contain at most 20 entries");
  return raw.map((item, index) => {
    if (typeof item === "string") {
      const text = item.trim();
      if (!text || text.length > 500) throw new IntakeError("invalid-evidence", `evidence[${index}] must be 1-500 characters`);
      return { kind: "note", value: text };
    }
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new IntakeError("invalid-evidence", `evidence[${index}] must be a string or object`);
    }
    const kind = optionalText(item.kind, "evidence-kind", 40);
    const value = optionalText(item.value ?? item.ref ?? item.note, "evidence-value", 500);
    if (!kind || !value) {
      throw new IntakeError("invalid-evidence", `evidence[${index}] needs kind and value`);
    }
    return { ...item, kind, value };
  });
}

function normalizeOccurredAt(raw) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const text = String(raw).trim();
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) throw new IntakeError("invalid-occurred-at", "occurred_at must be an ISO-8601 timestamp");
  return new Date(ms).toISOString();
}

export function validateTrustedIntake(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new IntakeError("invalid-body", "body must be a JSON object");
  }
  const kind = String(body.kind ?? "").trim();
  if (!KIND_SET.has(kind)) {
    throw new IntakeError("invalid-kind", `kind must be one of: ${TRUSTED_INTAKE_KINDS.join(", ")}`);
  }
  const status = String(body.status ?? "").trim();
  if (!STATUS_SET.has(status)) {
    throw new IntakeError(
      "invalid-status",
      "status must be 'completed' (or 'reported' for reported_by_other); planned/unconfirmed actions are never recorded as completed"
    );
  }
  const rule = KIND_RULES[kind];
  if (status === "reported" && kind !== "reported_by_other") {
    throw new IntakeError("invalid-status", "status 'reported' is only valid for reported_by_other");
  }
  if (status === "completed" && kind === "reported_by_other") {
    // A report of another actor's action is still a report, not first-person
    // completion. Keep the distinction explicit in storage.
    throw new IntakeError("invalid-status", "reported_by_other must use status 'reported'");
  }
  const participation = String(body.participation ?? "").trim();
  if (!PARTICIPATION_SET.has(participation) || !rule.participation.has(participation)) {
    throw new IntakeError(
      "invalid-participation",
      `participation for ${kind} must be one of: ${[...rule.participation].join(", ")}`
    );
  }
  const trustSource = String(body.trust_source ?? body.source ?? "").trim();
  if (!SOURCE_SET.has(trustSource) || !rule.source.has(trustSource)) {
    throw new IntakeError(
      "invalid-trust-source",
      `trust_source for ${kind} must be one of: ${[...rule.source].join(", ")}`
    );
  }
  const scopeInput = body.scope;
  if (!scopeInput || typeof scopeInput !== "object" || Array.isArray(scopeInput)) {
    throw new IntakeError("missing-scope", "scope is required: { agent_scope, workspace_scope }");
  }
  if (typeof scopeInput.agent_scope !== "string" || typeof scopeInput.workspace_scope !== "string") {
    throw new IntakeError(
      "missing-scope",
      "scope.agent_scope and scope.workspace_scope must both be explicit strings ('global' or a label)"
    );
  }
  const type = String(body.type ?? "history").trim();
  if (!INTAKE_TYPES.has(type)) {
    throw new IntakeError("invalid-type", `type must be one of: ${[...INTAKE_TYPES].join(", ")}`);
  }
  const importance = body.importance === undefined ? 3 : Number(body.importance);
  if (!Number.isInteger(importance) || importance < 1 || importance > 5) {
    throw new IntakeError("invalid-importance", "importance must be an integer 1-5");
  }
  const extraTags = Array.isArray(body.tags)
    ? body.tags.filter((tag) => typeof tag === "string").map((tag) => tag.trim()).filter(Boolean).slice(0, 20)
    : [];
  if (extraTags.some((tag) => isEventTag(tag))) {
    throw new IntakeError(
      "invalid-event-tag",
      "event:* tags are derived only from the trusted kind; they cannot be supplied as extra tags"
    );
  }
  return {
    kind,
    status,
    participation,
    trustSource,
    actor: requireText(body.actor, "actor", 200),
    title: requireText(body.title, "title", 200),
    content: requireText(body.content, "content", 20000),
    type,
    importance,
    occurredAt: normalizeOccurredAt(body.occurred_at),
    agentScope: normalizeExplicitScope(scopeInput.agent_scope),
    workspaceScope: normalizeExplicitScope(scopeInput.workspace_scope),
    evidence: normalizeEvidence(body.evidence),
    requestId: optionalText(body.request_id, "request-id", 120),
    extraTags
  };
}

/** Caller identity scope for durable request-id idempotency. */
export function intakeActorKey(actor) {
  return String(actor ?? "").normalize("NFKC").trim().toLowerCase();
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Deterministic fingerprint of a validated intake payload. */
export function intakeFingerprint(payload) {
  const material = {
    kind: payload.kind,
    status: payload.status,
    participation: payload.participation,
    trust_source: payload.trustSource,
    actor: payload.actor,
    title: payload.title,
    content: payload.content,
    type: payload.type,
    importance: payload.importance,
    occurred_at: payload.occurredAt ?? null,
    agent_scope: payload.agentScope,
    workspace_scope: payload.workspaceScope,
    evidence: payload.evidence,
    tags: [...payload.extraTags].sort()
  };
  return createHash("sha256").update(stableJson(material)).digest("hex");
}

export function createIntakeService({ service, store, writeTrustedIntake } = {}) {
  if (!service || !store) throw new Error("createIntakeService: service and store are required");
  if (typeof writeTrustedIntake !== "function") {
    throw new Error("createIntakeService: the private writeTrustedIntake channel is required");
  }
  const db = store.db;
  db.exec(INTAKE_SCHEMA);

  function findExisting(payload) {
    const rows = store.list({ type: payload.type, limit: 200 });
    const title = payload.title.trim();
    return rows.find((row) =>
      row.title.trim() === title &&
      scopeKeyOf(row.agent_scope) === payload.agentScope &&
      scopeKeyOf(row.workspace_scope) === payload.workspaceScope
    );
  }

  function toProvenance(row) {
    if (!row) return null;
    let evidence = [];
    try { evidence = JSON.parse(row.evidence); } catch { evidence = []; }
    return { ...row, evidence: Array.isArray(evidence) ? evidence : [] };
  }

  function saveProvenance(payload, memoryId) {
    const id = randomUUID();
    const at = new Date().toISOString();
    db.prepare(
      `INSERT INTO memory_trusted_provenance
         (id, memory_id, kind, actor, participation, trust_source, status, occurred_at,
          agent_scope, workspace_scope, evidence, request_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, memoryId, payload.kind, payload.actor, payload.participation, payload.trustSource,
      payload.status, payload.occurredAt ?? null, payload.agentScope, payload.workspaceScope,
      JSON.stringify(payload.evidence), payload.requestId ?? null, at
    );
    return toProvenance(db.prepare(
      "SELECT * FROM memory_trusted_provenance WHERE id = ?"
    ).get(id));
  }

  function provenanceById(id) {
    return toProvenance(db.prepare(
      "SELECT * FROM memory_trusted_provenance WHERE id = ?"
    ).get(String(id ?? "")));
  }

  function requestKeyFor(payload) {
    return `${intakeActorKey(payload.actor)}\u0000${payload.requestId}`;
  }

  function memoryInput(payload, tags) {
    return {
      type: payload.type,
      title: payload.title,
      content: payload.content,
      tags,
      importance: payload.importance,
      source: "trusted_intake",
      occurred_at: payload.occurredAt,
      agent_scope: payload.agentScope,
      agent_scope_source: "explicit",
      workspace_scope: payload.workspaceScope,
      workspace_scope_source: "explicit"
    };
  }

  /**
   * Validate, save through the normal dedupe/importance/forget/archive path
   * via the closure-private trusted writer, and attach provenance atomically.
   * Event tags are derived here only; `request_id` uses a durable fingerprinted
   * idempotency key scoped by normalized actor identity.
   */
  function submit(body) {
    const payload = validateTrustedIntake(body);
    const eventTag = eventTagForKind(payload.kind);
    if (!eventTag) throw new IntakeError("invalid-kind", "unsupported trusted event kind");

    if (!payload.requestId) {
      // Legacy compatibility: no request id → retain ordinary title dedupe.
      const existing = findExisting(payload);
      const tags = [...new Set([...(existing?.tags ?? []), ...payload.extraTags])];
      let provenance = null;
      let result = null;
      service.transaction(() => {
        result = writeTrustedIntake(memoryInput(payload, tags), { kind: payload.kind, forceNew: false });
        provenance = saveProvenance(payload, result.memory.id);
      });
      return {
        action: result.action,
        memory: service.toApiList([result.memory])[0],
        provenance,
        derived_tags: [eventTag],
        replayed: false
      };
    }

    const requestKey = requestKeyFor(payload);
    const fingerprint = intakeFingerprint(payload);
    let provenance = null;
    let result = null;
    let replayed = false;
    service.transaction(() => {
      const prior = db.prepare(
        "SELECT * FROM memory_trusted_requests WHERE request_key = ?"
      ).get(requestKey);
      if (prior) {
        if (prior.fingerprint !== fingerprint) {
          throw new IntakeError(
            "request-id-conflict",
            "request_id was already used with a different trusted-intake payload",
            { request_id: payload.requestId }
          );
        }
        const memory = store.getById(prior.memory_id);
        const priorProvenance = provenanceById(prior.provenance_id);
        if (!memory || !priorProvenance) {
          throw new IntakeError(
            "request-id-conflict",
            "request_id points at a missing stored experience",
            { request_id: payload.requestId }
          );
        }
        result = { action: "replayed", memory };
        provenance = priorProvenance;
        replayed = true;
        return;
      }
      // ID-bearing distinct experiences never title-dedupe into an earlier one.
      result = writeTrustedIntake(memoryInput(payload, payload.extraTags), {
        kind: payload.kind,
        forceNew: true
      });
      provenance = saveProvenance(payload, result.memory.id);
      db.prepare(
        `INSERT INTO memory_trusted_requests
           (request_key, request_id, actor_key, fingerprint, memory_id, provenance_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        requestKey, payload.requestId, intakeActorKey(payload.actor), fingerprint,
        result.memory.id, provenance.id, new Date().toISOString()
      );
    }, { immediate: true });

    return {
      action: result.action,
      memory: service.toApiList([result.memory])[0],
      provenance,
      derived_tags: [eventTag],
      replayed
    };
  }

  function provenanceFor(memoryId) {
    return db.prepare(
      "SELECT * FROM memory_trusted_provenance WHERE memory_id = ? ORDER BY created_at DESC, id"
    ).all(String(memoryId ?? "")).map(toProvenance);
  }

  return { submit, validate: validateTrustedIntake, provenanceFor };
}
