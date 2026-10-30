// Mneme-lite cross-Session recent activity core.
//
// Standalone and opt-in: the caller supplies an already-open DatabaseSync from
// the selected Workspace's isolated Mneme store. This module creates only its
// own additive `recent_activity_*` tables/indexes, never reads or writes the
// long-term `memories` table, never feeds Dream/Sleep, and calls no LLM.
//
// Trust model:
// - Every write/read takes the actual trusted Host Session and an
//   `allowSession(session)` callback supplied by the mounted runtime.
// - When the runtime supplies `resolveTrustedSession(id)`, every Session is
//   re-authorized through that trusted Host lookup before `allowSession` runs.
//   The returned object must carry the exact requested stable ID; a missing,
//   throwing or mismatched lookup fails closed. This keeps a frozen
//   `header.agentPreset` available to the model access boundary for stored
//   source Sessions and shared targets instead of an ID-only placeholder.
// - Without a resolver (direct module tests and legacy hosts), stored source
//   Sessions are re-authorized from their exact stable ID via
//   `allowSession({ id })`; the core deliberately never retains Host Session
//   objects or raw chat logs.
// - `isTrustedOwner(session)` is a Host-authenticated predicate, default false.
// - Session names, titles, presets, models, paths and caller arguments are never
//   authorization evidence.
// - Every public method fails closed and returns a result object; storage or
//   callback failures never throw into the host's session/event chain.

import { createHash } from "node:crypto";

export const RECENT_ACTIVITY_LIMITS = Object.freeze({
  TTL_HOURS: Object.freeze([1, 6, 24, 72]),
  DEFAULT_TTL_HOURS: 24,
  DEFAULT_MAX_ITEMS: 3,
  MAX_ITEMS: 10,
  DEFAULT_MAX_TOKENS: 300,
  MIN_MAX_TOKENS: 100,
  MAX_MAX_TOKENS: 800,
  MAX_SUMMARY_CHARS: 800,
  MAX_TOPIC_CHARS: 80,
  MAX_OUTCOME_CHARS: 120,
  // Retained for callers that referenced the original excerpt limits. The
  // stored summary no longer copies messages at these lengths.
  MAX_USER_CHARS: 300,
  MAX_ASSISTANT_CHARS: 400,
  MAX_EVENTS_TOTAL: 500,
  MAX_EVENTS_PER_SESSION: 50,
  // Maximum Host event positions read for one completed turn. The Host log is
  // append-only and sequence numbers are positions, so a half-open range of
  // this size is a fixed-cost suffix ending immediately before the trusted
  // turn/end. A turn longer than this degrades conservatively (see below).
  MAX_TURN_EVENT_WINDOW: 256,
  MAX_POLICY_ROWS: 200,
  MAX_SHARED_TARGETS: 32,
  MAX_QUERY_CHARS: 200,
  MAX_SOURCE_FILTER: 32,
  MAX_ID_CHARS: 256,
  ITEM_OVERHEAD_TOKENS: 8
});

const TTL_HOURS = new Set(RECENT_ACTIVITY_LIMITS.TTL_HOURS);
const MODES = new Set(["self", "owner", "shared"]);
const HOUR_MS = 60 * 60 * 1000;

// Additive and idempotent. These are new names; no existing Mneme table is
// altered, migrated, read or written. `workspace_id` is defence in depth on top
// of the per-Workspace isolated database.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS recent_activity_events (
  idempotency_key   TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  turn_seq          INTEGER NOT NULL,
  kind              TEXT NOT NULL,
  summary           TEXT NOT NULL,
  occurred_at       INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  created_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_recent_activity_turn
  ON recent_activity_events(workspace_id, source_session_id, turn_seq);
CREATE INDEX IF NOT EXISTS idx_recent_activity_source_time
  ON recent_activity_events(workspace_id, source_session_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_recent_activity_expiry
  ON recent_activity_events(workspace_id, expires_at);

CREATE TABLE IF NOT EXISTS recent_activity_source_policy (
  workspace_id      TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  mode              TEXT NOT NULL DEFAULT 'self',
  allowlist         TEXT NOT NULL DEFAULT '[]',
  enabled           INTEGER NOT NULL DEFAULT 1,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, source_session_id)
);
CREATE INDEX IF NOT EXISTS idx_recent_activity_policy_updated
  ON recent_activity_source_policy(workspace_id, updated_at);
`;

// Additive upgrade for databases created before the `enabled` switch existed.
// `CREATE TABLE IF NOT EXISTS` cannot add a column, so check the live table and
// add it only when missing. Existing modes, allowlists and timestamps are
// preserved; the default keeps every old policy enabled.
function ensurePolicyEnabledColumn(db) {
  const columns = db.prepare(
    "PRAGMA table_info(recent_activity_source_policy)"
  ).all();
  const present = columns.some((column) => column?.name === "enabled");
  if (!present) {
    db.exec(
      "ALTER TABLE recent_activity_source_policy ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1"
    );
  }
}

function stableId(value) {
  try {
    return typeof value === "string"
      && value.trim() !== ""
      && value.length <= RECENT_ACTIVITY_LIMITS.MAX_ID_CHARS
      ? value
      : null;
  } catch {
    return null;
  }
}

function sessionIdOf(session) {
  try {
    return stableId(session?.id);
  } catch {
    return null;
  }
}

function eventSeq(event) {
  try {
    const value = event?.seq;
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function normalizeConfig(next = {}) {
  let ttlHours = RECENT_ACTIVITY_LIMITS.DEFAULT_TTL_HOURS;
  let maxItems = RECENT_ACTIVITY_LIMITS.DEFAULT_MAX_ITEMS;
  let maxTokens = RECENT_ACTIVITY_LIMITS.DEFAULT_MAX_TOKENS;
  try {
    const ttl = Number(next?.ttlHours);
    if (TTL_HOURS.has(ttl)) ttlHours = ttl;
    maxItems = clampInteger(
      next?.maxItems,
      1,
      RECENT_ACTIVITY_LIMITS.MAX_ITEMS,
      RECENT_ACTIVITY_LIMITS.DEFAULT_MAX_ITEMS
    );
    maxTokens = clampInteger(
      next?.maxTokens,
      RECENT_ACTIVITY_LIMITS.MIN_MAX_TOKENS,
      RECENT_ACTIVITY_LIMITS.MAX_MAX_TOKENS,
      RECENT_ACTIVITY_LIMITS.DEFAULT_MAX_TOKENS
    );
  } catch {
    // Invalid/opaque configuration falls back to the safe defaults.
  }
  return { ttlHours, maxItems, maxTokens };
}

function safeReason(value) {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim().slice(0, 80)
    : null;
}

function accessDecision(allowSession, session) {
  if (typeof allowSession !== "function") {
    return { allowed: false, reason: "access-check-unavailable" };
  }
  try {
    const decision = allowSession(session);
    if (decision === true || decision?.allowed === true) {
      return { allowed: true, reason: "ok" };
    }
    return { allowed: false, reason: safeReason(decision?.reason) ?? "access-denied" };
  } catch {
    return { allowed: false, reason: "access-check-failed" };
  }
}

// A resolver is a trusted Host capability, not caller input. It either yields
// the live trusted Session object for an exact stable ID or nothing. Returning
// a different ID is treated like a miss so a buggy/hostile lookup cannot swap
// identity. The `available` flag distinguishes "no resolver" (legacy direct
// core use) from "resolver present but this ID cannot be verified" (deny).
function trustedSessionById(resolveTrustedSession, sessionId) {
  if (typeof resolveTrustedSession !== "function") {
    return { available: false, session: null };
  }
  try {
    const session = resolveTrustedSession(sessionId);
    if (sessionIdOf(session) !== sessionId) {
      return { available: true, session: null };
    }
    return { available: true, session };
  } catch {
    return { available: true, session: null };
  }
}

function accessDecisionForSession(allowSession, resolveTrustedSession, session) {
  const sessionId = sessionIdOf(session);
  if (sessionId === null) return { allowed: false, reason: "missing-session-id" };
  const trusted = trustedSessionById(resolveTrustedSession, sessionId);
  if (!trusted.available) return accessDecision(allowSession, session);
  if (trusted.session === null) {
    return { allowed: false, reason: "session-identity-unavailable" };
  }
  return accessDecision(allowSession, trusted.session);
}

function accessDecisionForSessionId(allowSession, resolveTrustedSession, sessionId) {
  const trusted = trustedSessionById(resolveTrustedSession, sessionId);
  if (!trusted.available) return accessDecision(allowSession, { id: sessionId });
  if (trusted.session === null) {
    return { allowed: false, reason: "session-identity-unavailable" };
  }
  return accessDecision(allowSession, trusted.session);
}

function crossSessionDecision(allowCrossSession, sourceSessionId, targetSessionId) {
  if (typeof allowCrossSession !== "function") return { allowed: true, reason: "ok" };
  try {
    return allowCrossSession(sourceSessionId, targetSessionId) === true
      ? { allowed: true, reason: "ok" }
      : { allowed: false, reason: "scene-sharing-denied" };
  } catch {
    return { allowed: false, reason: "scene-sharing-denied" };
  }
}

function sharedTargetsDecision(allowSession, sessionIds, resolveTrustedSession, sourceSessionId, allowCrossSession) {
  // Every exact target is independently authorized through the same Workspace
  // gate. A GUI can therefore never pre-authorize an unrelated/unknown Session.
  // With a trusted Host resolver the full identity (including the frozen
  // header) is what the access boundary sees, never the caller's ID alone.
  for (const sessionId of sessionIds) {
    const decision = accessDecisionForSessionId(allowSession, resolveTrustedSession, sessionId);
    if (!decision.allowed) return decision;
    const pair = crossSessionDecision(allowCrossSession, sourceSessionId, sessionId);
    if (!pair.allowed) return pair;
  }
  return { allowed: true, reason: "ok" };
}

function ownerDecision(isTrustedOwner, session) {
  if (typeof isTrustedOwner !== "function") return false;
  try {
    return isTrustedOwner(session) === true;
  } catch {
    return false;
  }
}

function textOf(content) {
  try {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    const parts = [];
    for (const block of content) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (block?.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
      // Reasoning/private blocks are never collected.
    }
    return parts.join("\n");
  } catch {
    return "";
  }
}

function isPublicUserEvent(event) {
  try {
    if (event?.type !== "user/message") return false;
    const source = event?.data?.source;
    if (source === undefined || source === null) return true; // legacy user event
    // Only the historical absent/null source is grandfathered. Any present
    // source must be a plain object that explicitly identifies a user message;
    // strings, arrays, numbers and objects without kind fail closed.
    if (typeof source !== "object" || Array.isArray(source)) return false;
    if (source.kind !== "user") return false;
    // A plugin/system injection can carry source.kind "user"; it is not a
    // public user-authored message. A malformed plugin field also fails closed.
    if (source.plugin !== undefined && source.plugin !== null) {
      if (typeof source.plugin !== "string" || source.plugin.trim() !== "") return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isPublicAssistantEvent(event) {
  try {
    if (event?.type !== "assistant/message") return false;
    const message = event?.data?.message;
    if (message?.role !== undefined && message.role !== "assistant") return false;
    if (message?.partial === true || message?.incomplete === true) return false;
    const status = message?.status;
    if (status === "pending" || status === "in_progress" || status === "streaming") return false;
    return true;
  } catch {
    return false;
  }
}

function explicitError(value) {
  // Unknown is not success: only a real boolean is evidence.
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

function toolOutcome(event) {
  try {
    if (event?.type === "tool/code-dispatch") {
      const error = explicitError(event?.data?.isError);
      return error === null ? null : { error };
    }
    if (event?.type !== "tool/result") return null;
    const message = event?.data?.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      const dataError = explicitError(event?.data?.isError);
      return dataError === null ? null : { error: dataError };
    }
    const status = message.status;
    if (status === "pending" || status === "in_progress" || status === "streaming") return null;
    const blocks = Array.isArray(message.content) ? message.content : [];
    const legacy = blocks.find((block) => block?.type === "tool-result");
    if (legacy) {
      const error = explicitError(legacy.isError);
      return error === null ? null : { error };
    }
    // Newer DSH shape: a final tool message carrying an explicit boolean
    // isError. A missing/unknown isError cannot support agent_action.
    const error = explicitError(message.isError);
    if (error !== null) return { error };
    const dataError = explicitError(event?.data?.isError);
    return dataError === null ? null : { error: dataError };
  } catch {
    return null;
  }
}

function oneLine(text) {
  return typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
}

function clip(text, max) {
  const value = typeof text === "string" ? text : "";
  if (value.length <= max) return value;
  if (max <= 1) return "…".slice(0, max);
  return `${value.slice(0, max - 1)}…`;
}

// A bounded topic/outcome snippet, not a message copy. Prefer the first
// complete sentence when it fits; otherwise clip. Long inputs are always cut.
function firstSentence(text, max) {
  const normalized = oneLine(text);
  if (!normalized) return "";
  const boundary = normalized.search(/[.!?](?:\s|$)/);
  const head = boundary >= 0 && boundary + 1 <= max
    ? normalized.slice(0, boundary + 1)
    : normalized;
  return clip(head, max);
}

function quotedSnippet(text) {
  return `"${text.replace(/"/g, "'")}"`;
}

// Read only the bounded suffix immediately before the trusted turn/end.
//
// The installed Host exposes `snapshotEvents(fromSeq, toSeqExclusive)` as a
// half-open slice of its append-only log. Older Hosts may ignore those
// arguments, and some callers only expose `.events`; both paths are therefore
// filtered by event sequence and capped locally to the same fixed limit. A
// bounded read means a long-lived Session does not turn every completed turn
// into a full-history scan. Synchronous snapshot access is deprecated by the
// Host; this keeps the callback bounded, but a future async event stream would
// be preferable and is intentionally not redesigned here.
function snapshotTurnWindow(session, turnSeq) {
  const cap = RECENT_ACTIVITY_LIMITS.MAX_TURN_EVENT_WINDOW;
  const startSeq = Math.max(0, turnSeq - cap);

  let raw = null;
  try {
    if (typeof session?.snapshotEvents === "function") {
      raw = session.snapshotEvents(startSeq, turnSeq);
    }
  } catch {
    raw = null;
  }
  if (!Array.isArray(raw)) {
    try {
      raw = session?.events;
    } catch {
      raw = null;
    }
  }
  if (!Array.isArray(raw)) {
    return {
      events: [],
      startSeq,
      turnSeq,
      previousEnd: null,
      partial: false
    };
  }

  const filtered = [];
  for (const event of raw) {
    const seq = eventSeq(event);
    // The upper bound is exclusive: the trusted turn/end itself is never part
    // of the summarized window. Events without a usable sequence are ignored
    // because they cannot be placed on the trusted side of the bound.
    if (seq === null || seq < startSeq || seq >= turnSeq) continue;
    filtered.push(event);
  }
  // A conforming Host already returned at most `cap` positions. Keep only the
  // newest positions if an older implementation ignored the range arguments or
  // a fallback array was larger than the requested window.
  const events = filtered.length > cap ? filtered.slice(-cap) : filtered;

  let previousEnd = null;
  for (const event of events) {
    if (event?.type !== "turn/end") continue;
    const seq = eventSeq(event);
    if (seq === null) continue;
    previousEnd = previousEnd === null ? seq : Math.max(previousEnd, seq);
  }

  // If the window does not start at the log beginning and contains no known
  // turn boundary, the current turn may be longer than the cap. Content still
  // belongs to the current turn, but its start could not be observed.
  const partial = previousEnd === null && startSeq > 0;
  return { events, startSeq, turnSeq, previousEnd, partial };
}

// Deterministic, bounded activity description of exactly one completed turn.
// Only short normalized topic/outcome snippets are persisted, never the full
// messages. Tool output is never copied; a structurally verified, explicitly
// non-error tool result is used only as evidence for "agent_action". A
// tool/call alone or an ambiguous result can never become "agent_action".
function buildTurnSummary(session, turnSeq) {
  const windowInfo = snapshotTurnWindow(session, turnSeq);
  const previousEnd = windowInfo.previousEnd;

  // Do not merge across a known previous turn/end. When no boundary is visible
  // in a truncated window, the filtered events are still known to be after the
  // Host's last turn/end (or the log start), so they can only be current-turn
  // events; they are summarized as a partial suffix below.
  const window = previousEnd === null
    ? windowInfo.events
    : windowInfo.events.filter((event) => {
      const seq = eventSeq(event);
      return seq !== null && seq > previousEnd;
    });
  if (window.length === 0) return null;

  let lastUserIndex = -1;
  let lastUserText = "";
  for (let index = 0; index < window.length; index += 1) {
    const event = window[index];
    if (!isPublicUserEvent(event)) continue;
    const text = textOf(event?.data?.content).trim();
    if (text) {
      lastUserIndex = index;
      lastUserText = text;
    }
  }

  const assistantStart = lastUserIndex >= 0 ? lastUserIndex + 1 : 0;
  let lastAssistantText = "";
  for (let index = assistantStart; index < window.length; index += 1) {
    const event = window[index];
    if (!isPublicAssistantEvent(event)) continue;
    const text = textOf(event?.data?.message?.content ?? event?.data?.content).trim();
    if (text) lastAssistantText = text;
  }

  let nonErrorResults = 0;
  let errorResults = 0;
  // A partial window cannot prove that no earlier tool error occurred, so it
  // contributes no tool-success evidence and is never classified as
  // "agent_action". This avoids asserting unverified success for long turns.
  if (!windowInfo.partial) {
    for (let index = assistantStart; index < window.length; index += 1) {
      const outcome = toolOutcome(window[index]);
      if (!outcome) continue;
      if (outcome.error) errorResults += 1;
      else nonErrorResults += 1;
    }
  }

  const topic = firstSentence(lastUserText, RECENT_ACTIVITY_LIMITS.MAX_TOPIC_CHARS);
  const outcome = firstSentence(lastAssistantText, RECENT_ACTIVITY_LIMITS.MAX_OUTCOME_CHARS);
  if (!topic && !outcome) return null;

  // A concise, extractive activity description. Topic and outcome are small
  // normalized snippets; full long user/assistant messages are never stored
  // (a short message can fit inside the snippet cap).
  const parts = [];
  parts.push(topic ? `Topic: ${quotedSnippet(topic)}` : "Topic: none captured");
  parts.push(outcome
    ? `Outcome: assistant reply began ${quotedSnippet(outcome)}`
    : "Outcome: no public assistant reply captured");
  if (nonErrorResults > 0 || errorResults > 0) {
    const evidence = [];
    if (nonErrorResults > 0) {
      evidence.push(`${nonErrorResults} non-error tool result${nonErrorResults === 1 ? "" : "s"}`);
    }
    if (errorResults > 0) {
      evidence.push(`${errorResults} error tool result${errorResults === 1 ? "" : "s"}`);
    }
    parts.push(`Tool evidence: ${evidence.join(", ")}`);
  }
  if (windowInfo.partial) {
    parts.push("Scope: partial turn window");
  }
  const summary = clip(parts.join("; "), RECENT_ACTIVITY_LIMITS.MAX_SUMMARY_CHARS);

  return {
    summary,
    kind: !windowInfo.partial && nonErrorResults > 0 && errorResults === 0
      ? "agent_action"
      : "conversation",
    partial: windowInfo.partial
  };
}

function idempotencyKey(workspaceId, sourceSessionId, turnSeq) {
  // The stable Session ID + event sequence are the inputs. The Workspace ID is
  // included only as a namespace so one physical DB can never collide two
  // Workspace scopes; the module still derives the key from those event facts.
  return createHash("sha256")
    .update(JSON.stringify([workspaceId, sourceSessionId, turnSeq]), "utf8")
    .digest("hex");
}

function normalizePolicyInput(policy) {
  if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
    return { ok: false, reason: "invalid-policy" };
  }
  // `enabled` is independent of mode. It may be omitted to preserve the
  // current switch, but a supplied value must be a real boolean.
  let enabled;
  if (policy.enabled !== undefined) {
    if (typeof policy.enabled !== "boolean") {
      return { ok: false, reason: "invalid-policy" };
    }
    enabled = policy.enabled;
  }
  if (!MODES.has(policy.mode)) return { ok: false, reason: "invalid-policy" };
  if (policy.mode !== "shared") {
    return { ok: true, mode: policy.mode, sharedSessionIds: [], enabled };
  }
  const raw = policy.sharedSessionIds;
  if (!Array.isArray(raw) || raw.length > RECENT_ACTIVITY_LIMITS.MAX_SHARED_TARGETS) {
    return { ok: false, reason: "invalid-policy" };
  }
  const ids = [];
  const seen = new Set();
  for (const entry of raw) {
    const id = stableId(entry);
    if (id === null) return { ok: false, reason: "invalid-policy" };
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return { ok: true, mode: "shared", sharedSessionIds: ids, enabled };
}

function parsePolicyRow(mode, allowlist) {
  if (mode === "self") return { ok: true, mode: "self", sharedSessionIds: [] };
  if (mode === "owner") return { ok: true, mode: "owner", sharedSessionIds: [] };
  if (mode !== "shared") return { ok: false };
  let list;
  try {
    list = JSON.parse(allowlist ?? "[]");
  } catch {
    return { ok: false };
  }
  if (!Array.isArray(list) || list.length > RECENT_ACTIVITY_LIMITS.MAX_SHARED_TARGETS) {
    return { ok: false };
  }
  const ids = [];
  const seen = new Set();
  for (const entry of list) {
    const id = stableId(entry);
    if (id === null) return { ok: false };
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return { ok: true, mode: "shared", sharedSessionIds: ids };
}

function normalizeSources(value) {
  if (value === undefined) return { ok: true, ids: null };
  if (!Array.isArray(value) || value.length > RECENT_ACTIVITY_LIMITS.MAX_SOURCE_FILTER) {
    return { ok: false, reason: "invalid-source-filter" };
  }
  const ids = [];
  const seen = new Set();
  for (const entry of value) {
    const id = stableId(entry);
    if (id === null) return { ok: false, reason: "invalid-source-filter" };
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return { ok: true, ids };
}

function timeOption(value) {
  if (value === undefined || value === null) return { ok: true, value: null };
  const number = Number(value);
  return Number.isFinite(number) ? { ok: true, value: number } : { ok: false };
}

function normalizeReadOptions(input, config) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "invalid-options" };
  }
  const sources = normalizeSources(input.sources);
  if (!sources.ok) return sources;
  const since = timeOption(input.since);
  if (!since.ok) return { ok: false, reason: "invalid-time-range" };
  const until = timeOption(input.until);
  if (!until.ok) return { ok: false, reason: "invalid-time-range" };
  const empty = since.value !== null && until.value !== null && since.value > until.value;

  let query = "";
  if (input.query !== undefined) {
    if (typeof input.query !== "string") return { ok: false, reason: "invalid-query" };
    query = clip(input.query.trim(), RECENT_ACTIVITY_LIMITS.MAX_QUERY_CHARS);
  }

  return {
    ok: true,
    empty,
    sources: sources.ids,
    includeSelf: input.includeSelf !== false,
    since: since.value,
    until: until.value,
    query,
    maxItems: clampInteger(
      input.maxItems,
      1,
      RECENT_ACTIVITY_LIMITS.MAX_ITEMS,
      config.maxItems
    ),
    maxTokens: clampInteger(
      input.maxTokens,
      RECENT_ACTIVITY_LIMITS.MIN_MAX_TOKENS,
      RECENT_ACTIVITY_LIMITS.MAX_MAX_TOKENS,
      config.maxTokens
    ),
    now: input.now
  };
}

export function estimateRecentActivityTokens(text) {
  const value = String(text ?? "");
  let cjk = 0;
  for (const ch of value) if (ch >= "\u4e00" && ch <= "\u9fff") cjk += 1;
  return Math.ceil(cjk * 0.6 + (value.length - cjk) * 0.25);
}

function denied(reason, extra = {}) {
  return {
    ok: false,
    reason,
    items: [],
    count: 0,
    estimatedTokens: 0,
    truncated: false,
    ...extra
  };
}

/**
 * Create a recent-activity core over an already-open isolated Mneme database.
 * Construction never throws: an invalid/closed database yields an unavailable
 * core whose methods fail closed.
 * @param {object} options
 * @param {import("node:sqlite").DatabaseSync} options.db open DatabaseSync
 * @param {string} options.workspaceId stable selected Workspace ID
 * @param {(session: object) => (boolean|{allowed: boolean, reason?: string})} [options.allowSession]
 * @param {(sessionId: string) => (object|null)} [options.resolveTrustedSession] trusted
 *   Host lookup for the live Session behind an exact stable ID. When supplied, a
 *   lookup miss/mismatch fails closed instead of falling back to an ID-only object.
 * @param {(sourceSessionId: string, targetSessionId: string) => boolean} [options.allowCrossSession]
 *   Host-derived pair gate for raw recent activity. A false/throwing gate denies
 *   cross-Session grants and reads; it is never provided by model arguments.
 * @param {(session: object) => boolean} [options.isTrustedOwner]
 * @param {object} [options.config]
 * @param {() => number} [options.now]
 * @param {object} [options.logger]
 * @returns {object}
 */
export function createRecentActivityCore({
  db = null,
  workspaceId = null,
  allowSession = null,
  resolveTrustedSession = null,
  allowCrossSession = null,
  onSharedRead = null,
  isTrustedOwner = null,
  config = {},
  now = Date.now,
  logger = null
} = {}) {
  const workspace = stableId(workspaceId);
  let options = normalizeConfig(config);
  let state = { ok: false, reason: "storage-unavailable" };

  const clock = typeof now === "function"
    ? now
    : () => now;

  const resolveNow = (callNow) => {
    const direct = Number(callNow);
    if (callNow !== undefined && callNow !== null && Number.isFinite(direct) && direct >= 0) {
      return direct;
    }
    try {
      const value = Number(clock());
      return Number.isFinite(value) && value >= 0 ? value : Date.now();
    } catch {
      return Date.now();
    }
  };

  const logOnce = (reason) => {
    try {
      logger?.warn?.(`[dsh-mneme] recent activity unavailable: ${reason}`);
    } catch {
      // Logging must never change the result.
    }
  };

  if (workspace === null) {
    state = { ok: false, reason: "missing-workspace-id" };
    logOnce(state.reason);
  } else {
    try {
      if (!db || typeof db.exec !== "function" || typeof db.prepare !== "function") {
        throw new Error("invalid-database");
      }
      db.exec(SCHEMA);
      ensurePolicyEnabledColumn(db);
      state = { ok: true, reason: "ok" };
    } catch {
      state = { ok: false, reason: "storage-unavailable" };
      logOnce(state.reason);
    }
  }

  function rollback(savepoint) {
    try {
      db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      db.exec(`RELEASE SAVEPOINT ${savepoint}`);
    } catch {
      // The original failure wins; a missing savepoint is already rolled back.
    }
  }

  function pruneCaps(sourceSessionId) {
    db.prepare(
      `DELETE FROM recent_activity_events
       WHERE workspace_id = ? AND source_session_id = ?
         AND rowid NOT IN (
           SELECT rowid FROM recent_activity_events
           WHERE workspace_id = ? AND source_session_id = ?
           ORDER BY occurred_at DESC, rowid DESC LIMIT ?
         )`
    ).run(
      workspace,
      sourceSessionId,
      workspace,
      sourceSessionId,
      RECENT_ACTIVITY_LIMITS.MAX_EVENTS_PER_SESSION
    );

    db.prepare(
      `DELETE FROM recent_activity_events
       WHERE workspace_id = ?
         AND rowid NOT IN (
           SELECT rowid FROM recent_activity_events
           WHERE workspace_id = ?
           ORDER BY occurred_at DESC, rowid DESC LIMIT ?
         )`
    ).run(workspace, workspace, RECENT_ACTIVITY_LIMITS.MAX_EVENTS_TOTAL);
  }

  function policyRowCount() {
    const row = db.prepare(
      "SELECT COUNT(*) AS count FROM recent_activity_source_policy WHERE workspace_id = ?"
    ).get(workspace);
    return Number(row?.count ?? 0);
  }

  function readPolicyRow(sourceSessionId) {
    const row = db.prepare(
      `SELECT mode, allowlist, enabled FROM recent_activity_source_policy
       WHERE workspace_id = ? AND source_session_id = ?`
    ).get(workspace, sourceSessionId);
    if (!row) return { exists: false, enabled: true };
    return {
      exists: true,
      mode: row.mode,
      allowlist: row.allowlist,
      enabled: Number(row.enabled) !== 0
    };
  }

  function readPolicy(sourceSessionId) {
    const row = readPolicyRow(sourceSessionId);
    if (!row.exists) {
      return { ok: true, mode: "self", sharedSessionIds: [], enabled: true };
    }
    const parsed = parsePolicyRow(row.mode, row.allowlist);
    if (!parsed.ok) return { ok: false, enabled: row.enabled };
    return { ...parsed, enabled: row.enabled };
  }

  /**
   * Handle only a trusted internal `session/event` turn/end. The caller must
   * pass the actual Host Session and event; this method ignores other events.
   */
  function recordTurnEnd(session, event, callOptions = {}) {
    try {
      if (!state.ok) return { ok: false, reason: state.reason };
      if (event?.type !== "turn/end") return { ok: false, reason: "not-turn-end" };

      const sourceSessionId = sessionIdOf(session);
      if (sourceSessionId === null) return { ok: false, reason: "missing-session-id" };
      const turnSeq = eventSeq(event);
      if (turnSeq === null) return { ok: false, reason: "missing-event-sequence" };

      const beforeRead = accessDecisionForSession(allowSession?.derive ?? allowSession, resolveTrustedSession, session);
      if (!beforeRead.allowed) return { ok: false, reason: beforeRead.reason };

      // The enabled switch is checked before any transcript snapshot. A
      // disabled Session therefore costs no summary work and records nothing.
      const sourcePolicy = readPolicy(sourceSessionId);
      if (!sourcePolicy.ok) return { ok: false, reason: "invalid-policy" };
      if (!sourcePolicy.enabled) return { ok: false, reason: "source-disabled" };

      const key = idempotencyKey(workspace, sourceSessionId, turnSeq);
      const existing = db.prepare(
        "SELECT 1 AS present FROM recent_activity_events WHERE idempotency_key = ?"
      ).get(key);
      if (existing) return { ok: false, reason: "duplicate" };

      const turn = buildTurnSummary(session, turnSeq);
      if (!turn) return { ok: false, reason: "no-public-text" };

      const occurredAt = resolveNow(callOptions.now);
      const expiresAt = occurredAt + options.ttlHours * HOUR_MS;

      db.exec("SAVEPOINT mneme_recent_activity_record");
      try {
        // Recheck the trusted Host Session immediately before the write commits.
        const beforeCommit = accessDecisionForSession(allowSession?.derive ?? allowSession, resolveTrustedSession, session);
        if (!beforeCommit.allowed) {
          rollback("mneme_recent_activity_record");
          return { ok: false, reason: beforeCommit.reason };
        }
        // A disable during summary collection must revoke the pending write.
        const policyBeforeCommit = readPolicy(sourceSessionId);
        if (!policyBeforeCommit.ok) {
          rollback("mneme_recent_activity_record");
          return { ok: false, reason: "invalid-policy" };
        }
        if (!policyBeforeCommit.enabled) {
          rollback("mneme_recent_activity_record");
          return { ok: false, reason: "source-disabled" };
        }

        const inserted = db.prepare(
          `INSERT OR IGNORE INTO recent_activity_events
           (idempotency_key, workspace_id, source_session_id, turn_seq, kind,
            summary, occurred_at, expires_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          key,
          workspace,
          sourceSessionId,
          turnSeq,
          turn.kind,
          turn.summary,
          occurredAt,
          expiresAt,
          occurredAt
        );

        if (Number(inserted.changes ?? 0) === 0) {
          db.exec("RELEASE SAVEPOINT mneme_recent_activity_record");
          return { ok: false, reason: "duplicate" };
        }

        db.prepare(
          "DELETE FROM recent_activity_events WHERE workspace_id = ? AND expires_at <= ?"
        ).run(workspace, occurredAt);
        pruneCaps(sourceSessionId);
        db.exec("RELEASE SAVEPOINT mneme_recent_activity_record");
        return {
          ok: true,
          recorded: true,
          kind: turn.kind,
          estimatedTokens: estimateRecentActivityTokens(turn.summary),
          turnSeq
        };
      } catch {
        rollback("mneme_recent_activity_record");
        return { ok: false, reason: "record-failed" };
      }
    } catch {
      return { ok: false, reason: "record-failed" };
    }
  }

  /**
   * Set the sharing policy for one source Session. `mode`, exact stable target
   * Session IDs and the independent `enabled` switch are accepted. The source
   * Session and every shared target are gated before and immediately before the
   * commit; read-time checks remain authoritative, so revocations affect the
   * next read.
   */
  function setSourcePolicy(sourceSession, policy = {}, callOptions = {}) {
    try {
      if (!state.ok) return { ok: false, reason: state.reason };
      const sourceSessionId = sessionIdOf(sourceSession);
      if (sourceSessionId === null) return { ok: false, reason: "missing-session-id" };

      const beforeRead = accessDecisionForSession(allowSession, resolveTrustedSession, sourceSession);
      if (!beforeRead.allowed) return { ok: false, reason: beforeRead.reason };

      const normalized = normalizePolicyInput(policy);
      if (!normalized.ok) return { ok: false, reason: normalized.reason };

      // Omitting `enabled` preserves the previous switch. A new Session starts
      // enabled; an unrelated mode/allowlist edit never silently re-enables a
      // Session the owner disabled.
      const existing = readPolicyRow(sourceSessionId);
      const enabled = normalized.enabled === undefined
        ? existing.enabled
        : normalized.enabled;

      // Shared grants are authorization state, so each exact target must be a
      // current member of this Workspace before anything is persisted.
      const targetsBeforeWrite = sharedTargetsDecision(
        allowSession,
        normalized.sharedSessionIds,
        resolveTrustedSession,
        sourceSessionId,
        allowCrossSession
      );
      if (!targetsBeforeWrite.allowed) {
        return { ok: false, reason: targetsBeforeWrite.reason };
      }

      const updatedAt = resolveNow(callOptions.now);
      const allowlist = JSON.stringify(normalized.sharedSessionIds);

      db.exec("SAVEPOINT mneme_recent_activity_policy");
      try {
        const beforeCommit = accessDecisionForSession(allowSession, resolveTrustedSession, sourceSession);
        if (!beforeCommit.allowed) {
          rollback("mneme_recent_activity_policy");
          return { ok: false, reason: beforeCommit.reason };
        }
        const targetsBeforeCommit = sharedTargetsDecision(
          allowSession,
          normalized.sharedSessionIds,
          resolveTrustedSession,
          sourceSessionId,
          allowCrossSession
        );
        if (!targetsBeforeCommit.allowed) {
          rollback("mneme_recent_activity_policy");
          return { ok: false, reason: targetsBeforeCommit.reason };
        }

        // Bounded-write rule: an existing row may always be updated. A brand
        // new row is rejected explicitly at the cap instead of evicting the
        // oldest policy, which could silently relax a disabled or shared
        // restriction back to the default `self` policy.
        const present = db.prepare(
          `SELECT 1 AS present FROM recent_activity_source_policy
           WHERE workspace_id = ? AND source_session_id = ?`
        ).get(workspace, sourceSessionId);
        if (!present && policyRowCount() >= RECENT_ACTIVITY_LIMITS.MAX_POLICY_ROWS) {
          rollback("mneme_recent_activity_policy");
          return { ok: false, reason: "policy-cap-reached" };
        }

        db.prepare(
          `INSERT INTO recent_activity_source_policy
           (workspace_id, source_session_id, mode, allowlist, enabled, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(workspace_id, source_session_id) DO UPDATE SET
             mode = excluded.mode,
             allowlist = excluded.allowlist,
             enabled = excluded.enabled,
             updated_at = excluded.updated_at`
        ).run(
          workspace,
          sourceSessionId,
          normalized.mode,
          allowlist,
          enabled ? 1 : 0,
          updatedAt
        );

        db.exec("RELEASE SAVEPOINT mneme_recent_activity_policy");
        return {
          ok: true,
          mode: normalized.mode,
          sharedSessionIds: [...normalized.sharedSessionIds],
          enabled
        };
      } catch {
        rollback("mneme_recent_activity_policy");
        return { ok: false, reason: "policy-write-failed" };
      }
    } catch {
      return { ok: false, reason: "policy-write-failed" };
    }
  }

  /** Read the current policy for a trusted source Session. */
  function getSourcePolicy(sourceSession, _callOptions = {}) {
    try {
      if (!state.ok) return { ok: false, reason: state.reason };
      const sourceSessionId = sessionIdOf(sourceSession);
      if (sourceSessionId === null) return { ok: false, reason: "missing-session-id" };

      const beforeRead = accessDecisionForSession(allowSession, resolveTrustedSession, sourceSession);
      if (!beforeRead.allowed) return { ok: false, reason: beforeRead.reason };

      const policy = readPolicy(sourceSessionId);
      if (!policy.ok) return { ok: false, reason: "invalid-policy" };
      return {
        ok: true,
        mode: policy.mode,
        sharedSessionIds: [...policy.sharedSessionIds],
        enabled: policy.enabled
      };
    } catch {
      return { ok: false, reason: "policy-read-failed" };
    }
  }

  /**
   * Preview bounded, policy-filtered summaries for a trusted target Session.
   * This never returns SQL rows or raw transcripts. `includeSelf` defaults true
   * so an explicit self query works; auto-injection may pass false because the
   * original Hot Memory already covers the current Session.
   */
  function readRecentActivity(targetSession, readOptions = {}) {
    try {
      if (!state.ok) return denied(state.reason);
      const targetSessionId = sessionIdOf(targetSession);
      if (targetSessionId === null) return denied("missing-session-id");

      const beforeRead = accessDecisionForSession(allowSession, resolveTrustedSession, targetSession);
      if (!beforeRead.allowed) return denied(beforeRead.reason);

      // A disabled target cannot read its own recent events. Auto-injection
      // treats this denial like an empty preview. The policy is re-read at the
      // final gate too, so a disable takes effect on the next read immediately.
      const targetPolicy = readPolicy(targetSessionId);
      if (!targetPolicy.ok) return denied("invalid-policy");
      if (!targetPolicy.enabled) return denied("source-disabled");

      const normalized = normalizeReadOptions(readOptions, options);
      if (!normalized.ok) return denied(normalized.reason);

      const now = resolveNow(normalized.now);
      let recheck = null;
      const requireTargetAllowed = () => {
        recheck = accessDecisionForSession(allowSession, resolveTrustedSession, targetSession);
        if (!recheck.allowed) return false;
        const policy = readPolicy(targetSessionId);
        if (!policy.ok) {
          recheck = { allowed: false, reason: "invalid-policy" };
          return false;
        }
        if (!policy.enabled) {
          recheck = { allowed: false, reason: "source-disabled" };
          return false;
        }
        return true;
      };

      if (normalized.empty) {
        if (!requireTargetAllowed()) return denied(recheck.reason);
        return {
          ok: true,
          reason: "ok",
          items: [],
          count: 0,
          estimatedTokens: 0,
          truncated: false
        };
      }

      const sourceRows = db.prepare(
        `SELECT DISTINCT source_session_id AS sourceSessionId
         FROM recent_activity_events
         WHERE workspace_id = ? AND expires_at > ?`
      ).all(workspace, now);

      const wanted = normalized.sources === null ? null : new Set(normalized.sources);
      const selected = [];
      const seenSources = new Set();
      let ownerChecked = false;
      let ownerTrusted = false;
      const isOwner = () => {
        if (!ownerChecked) {
          ownerTrusted = ownerDecision(isTrustedOwner, targetSession);
          ownerChecked = true;
        }
        return ownerTrusted;
      };

      for (const row of sourceRows) {
        const sourceSessionId = stableId(row?.sourceSessionId);
        if (sourceSessionId === null || seenSources.has(sourceSessionId)) continue;
        seenSources.add(sourceSessionId);
        if (wanted !== null && !wanted.has(sourceSessionId)) continue;

        if (typeof allowSession?.derive === 'function' &&
          !accessDecisionForSessionId(allowSession.derive, resolveTrustedSession, sourceSessionId).allowed) continue;

        if (sourceSessionId === targetSessionId) {
          if (normalized.includeSelf) selected.push(sourceSessionId);
          continue;
        }

        // Both source and target must still resolve to a trusted Session and be
        // members of the active Workspace. The stored ID is only a lookup key.
        const sourceGate = accessDecisionForSessionId(
          allowSession,
          resolveTrustedSession,
          sourceSessionId
        );
        if (!sourceGate.allowed) continue;
        if (!crossSessionDecision(allowCrossSession, sourceSessionId, targetSessionId).allowed) continue;

        const policy = readPolicy(sourceSessionId);
        if (!policy.ok) continue;
        if (!policy.enabled) continue;
        if (policy.mode === "self") continue;
        if (policy.mode === "owner") {
          if (!isOwner()) continue;
        } else if (policy.mode === "shared") {
          if (!policy.sharedSessionIds.includes(targetSessionId)) continue;
        } else {
          continue;
        }
        selected.push(sourceSessionId);
      }

      let rows = [];
      if (selected.length > 0) {
        const placeholders = selected.map(() => "?").join(", ");
        const parameters = [workspace, ...selected, now];
        let sql = `SELECT source_session_id AS sourceSessionId, kind, summary, occurred_at AS occurredAt
                   FROM recent_activity_events
                   WHERE workspace_id = ? AND source_session_id IN (${placeholders}) AND expires_at > ?`;
        if (normalized.since !== null) {
          sql += " AND occurred_at >= ?";
          parameters.push(normalized.since);
        }
        if (normalized.until !== null) {
          sql += " AND occurred_at <= ?";
          parameters.push(normalized.until);
        }
        sql += " ORDER BY occurred_at DESC, rowid DESC LIMIT ?";
        parameters.push(RECENT_ACTIVITY_LIMITS.MAX_EVENTS_TOTAL);
        rows = db.prepare(sql).all(...parameters);
      }

      // Recheck the trusted target and its enabled switch immediately before
      // ranking/returning.
      if (!requireTargetAllowed()) return denied(recheck.reason);

      const needle = normalized.query.toLowerCase();
      const items = [];
      let usedTokens = 0;
      let truncated = false;
      for (const row of rows) {
        if (row.sourceSessionId !== targetSessionId &&
          !crossSessionDecision(allowCrossSession, row.sourceSessionId, targetSessionId).allowed) continue;
        const summary = typeof row?.summary === "string" ? row.summary : "";
        if (needle && !summary.toLowerCase().includes(needle)) {
          truncated = true;
          continue;
        }
        if (items.length >= normalized.maxItems) {
          truncated = true;
          break;
        }
        const cost = estimateRecentActivityTokens(summary) + RECENT_ACTIVITY_LIMITS.ITEM_OVERHEAD_TOKENS;
        if (usedTokens + cost > normalized.maxTokens) {
          truncated = true;
          continue;
        }
        items.push({
          sourceSessionId: String(row.sourceSessionId),
          kind: row.kind === "agent_action" ? "agent_action" : "conversation",
          summary: clip(summary, RECENT_ACTIVITY_LIMITS.MAX_SUMMARY_CHARS),
          occurredAt: Number(row.occurredAt),
          estimatedTokens: cost
        });
        usedTokens += cost;
      }

      if (items.some(item=>item.sourceSessionId !== targetSessionId) && typeof onSharedRead === 'function') {
        onSharedRead(targetSession);
      }

      // Expired cleanup is maintenance, not a read dependency; a failure here
      // must not block the returned preview.
      try {
        db.prepare(
          "DELETE FROM recent_activity_events WHERE workspace_id = ? AND expires_at <= ?"
        ).run(workspace, now);
      } catch {
        // Best effort only.
      }

      return {
        ok: true,
        reason: "ok",
        items,
        count: items.length,
        estimatedTokens: usedTokens,
        truncated
      };
    } catch {
      return denied("read-failed");
    }
  }

  /**
   * Bounded, read-only aggregates for the owner GUI. Every query is scoped to
   * this core's Workspace ID. It returns counts, byte sizes and config only:
   * never summary text, SQL rows or any Workspace ID. Expired-but-unpruned rows
   * are retained storage and remain counted until normal maintenance removes
   * them. The method mutates nothing and is not called on the model read path.
   */
  function stats() {
    const empty = {
      eventCount: 0,
      sourceCounts: [],
      lastUpdatedAt: null,
      summaryBytes: 0,
      policyCount: 0,
      config: { ...options }
    };
    const toTime = (value) => {
      if (value === null || value === undefined) return null;
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    };
    try {
      if (!state.ok) return { ok: false, reason: state.reason, ...empty };

      const events = db.prepare(
        `SELECT COUNT(*) AS count,
                COALESCE(SUM(LENGTH(CAST(summary AS BLOB))), 0) AS bytes,
                MAX(occurred_at) AS lastEventAt
         FROM recent_activity_events
         WHERE workspace_id = ?`
      ).get(workspace);
      const policies = db.prepare(
        `SELECT COUNT(*) AS count, MAX(updated_at) AS lastPolicyAt
         FROM recent_activity_source_policy
         WHERE workspace_id = ?`
      ).get(workspace);
      // The event caps bound this GROUP BY to at most MAX_EVENTS_TOTAL rows.
      const sources = db.prepare(
        `SELECT source_session_id AS sourceSessionId, COUNT(*) AS count
         FROM recent_activity_events
         WHERE workspace_id = ?
         GROUP BY source_session_id
         ORDER BY count DESC, source_session_id ASC
         LIMIT ?`
      ).all(workspace, RECENT_ACTIVITY_LIMITS.MAX_EVENTS_TOTAL);

      const lastEventAt = toTime(events?.lastEventAt);
      const lastPolicyAt = toTime(policies?.lastPolicyAt);
      const lastUpdatedAt = lastEventAt === null
        ? lastPolicyAt
        : lastPolicyAt === null ? lastEventAt : Math.max(lastEventAt, lastPolicyAt);

      return {
        ok: true,
        reason: "ok",
        eventCount: Number(events?.count ?? 0),
        sourceCounts: sources.map((row) => ({
          sourceSessionId: String(row.sourceSessionId),
          count: Number(row.count ?? 0)
        })),
        lastUpdatedAt,
        summaryBytes: Number(events?.bytes ?? 0),
        policyCount: Number(policies?.count ?? 0),
        config: { ...options }
      };
    } catch {
      return { ok: false, reason: "stats-failed", ...empty };
    }
  }

  return {
    status() {
      return { ok: state.ok, reason: state.reason, workspaceId: workspace };
    },
    configure(partial) {
      try {
        if (partial && typeof partial === "object" && !Array.isArray(partial)) {
          options = normalizeConfig({ ...options, ...partial });
        }
      } catch {
        // Keep the previous valid configuration.
      }
      return { ...options };
    },
    getConfig() {
      return { ...options };
    },
    stats,
    onSessionEvent: recordTurnEnd,
    recordTurnEnd,
    setSourcePolicy,
    getSourcePolicy,
    readRecentActivity,
    previewRecentActivity: readRecentActivity
  };
}
