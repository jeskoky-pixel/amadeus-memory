import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkWorkspaceAccess } from "../src/workspace-gate.js";
import { createQQModelAccessGate } from "../src/qq-model-boundary.js";
import {
  createRecentActivityCore,
  estimateRecentActivityTokens,
  RECENT_ACTIVITY_LIMITS
} from "../src/recent-activity.js";

const HOUR = 60 * 60 * 1000;
const T0 = 1_700_000_000_000;
const tempDirs = [];
const databases = [];

function openDatabase(path) {
  const db = new DatabaseSync(path);
  databases.push(db);
  return db;
}

function tempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), "mneme-recent-activity-"));
  tempDirs.push(dir);
  return join(dir, "memory.db");
}

test.after(() => {
  for (const db of databases) {
    try { db.close(); } catch { /* already closed */ }
  }
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test("trusted Host headers allow ordinary cross-Session sharing while a present QQ Host keeps QQ isolated", () => {
  const db = openDatabase(tempDbPath());
  const events = [userEvent(1, "ordinary DSH work"), assistantEvent(2, "completed"), turnEnd(3)];
  const source = { ...hostSession("s1", events), header: { agentPreset: "standard" } };
  const target = { ...hostSession("s2"), header: { agentPreset: "standard" } };
  const qqSession = { ...hostSession("q1"), header: { agentPreset: "amadeus-qq" } };
  const trusted = new Map([["s1", source], ["s2", target], ["q1", qqSession]]);
  const ctx = { qq: { resolveTrustedSessionScene: id => id === "q1"
    ? { platform: "qq", botId: "10001", kind: "group", peerId: "20001" }
    : null } };
  const allowSession = createQQModelAccessGate({
    ctx, config: { sceneIsolationEnabled: false, sceneStrictQQ: false },
    authorizeWorkspace: session => ({ allowed: trusted.has(session?.id), workspaceId: "ws-a" })
  });
  const core = createRecentActivityCore({
    db, workspaceId: "ws-a", allowSession,
    resolveTrustedSession: id => trusted.get(id) ?? null
  });
  assert.equal(core.recordTurnEnd(source, endOf(events, 3), { now: T0 }).ok, true);
  assert.equal(core.setSourcePolicy(source, { mode: "shared", sharedSessionIds: ["s2"] }).ok, true);
  assert.equal(core.readRecentActivity(target, { now: T0 + 1 }).count, 1);
  assert.equal(core.setSourcePolicy(source, { mode: "shared", sharedSessionIds: ["q1"] }).ok, false,
    "a QQ target cannot be authorized by an ID-only placeholder or an ordinary preset");
  db.close();
});

test("missing, mismatched, throwing and revoked trusted identities fail closed", () => {
  const db = openDatabase(tempDbPath());
  const events = [userEvent(1, "trusted identity"), assistantEvent(2, "done"), turnEnd(3)];
  const source = { ...hostSession("s1", events), header: { agentPreset: "standard" } };
  const target = { ...hostSession("s2"), header: { agentPreset: "standard" } };
  const trusted = new Map([["s1", source], ["s2", target]]);
  const ctx = { qq: { resolveTrustedSessionScene: () => null } };
  const allowSession = createQQModelAccessGate({
    ctx, config: { sceneIsolationEnabled: false, sceneStrictQQ: false },
    authorizeWorkspace: session => ({ allowed: trusted.has(session?.id), workspaceId: "ws-a" })
  });
  let mode = "ok";
  const resolveTrustedSession = id => {
    if (mode === "throw") throw new Error("host unavailable");
    const hit = trusted.get(id);
    if (mode === "mismatch") return trusted.get("s1") ?? null;
    if (mode === "no-header") return hit ? { id: hit.id } : null;
    if (mode === "revoked-source" && id === "s1") return null;
    return hit ?? null;
  };
  const core = createRecentActivityCore({
    db, workspaceId: "ws-a", allowSession, resolveTrustedSession
  });
  assert.equal(core.recordTurnEnd(source, endOf(events, 3), { now: T0 }).ok, true);
  assert.equal(core.setSourcePolicy(source, { mode: "shared", sharedSessionIds: ["s2"] }).ok, true);
  assert.equal(core.readRecentActivity(target, { now: T0 + 1 }).count, 1);

  // The target's trusted object lacks the frozen header: a present QQ Host
  // cannot verify ordinary provenance, so the read is denied rather than
  // falling back to the caller's object.
  mode = "no-header";
  assert.equal(core.readRecentActivity(target, { now: T0 + 1 }).ok, false);
  assert.equal(core.readRecentActivity(target, { now: T0 + 1 }).reason, "qq-preset-unverified");

  // A lookup that swaps in another Session's object is a miss.
  mode = "mismatch";
  assert.equal(core.readRecentActivity(target, { now: T0 + 1 }).reason, "session-identity-unavailable");
  mode = "throw";
  assert.equal(core.readRecentActivity(target, { now: T0 + 1 }).reason, "session-identity-unavailable");

  // Revoking the stored source hides its already-granted summary on the next read.
  mode = "revoked-source";
  const revoked = core.readRecentActivity(target, { now: T0 + 1 });
  assert.equal(revoked.ok, true);
  assert.equal(revoked.count, 0, "a source that no longer resolves must not be read");

  mode = "ok";
  assert.equal(
    core.setSourcePolicy(source, { mode: "shared", sharedSessionIds: ["ghost"] }).ok,
    false,
    "an unknown target never becomes a shared grant"
  );
  db.close();
});

test("a stored QQ source cannot be shared out or re-authorized while QQ is unverified", () => {
  const db = openDatabase(tempDbPath());
  const qqEvents = [userEvent(1, "qq private topic"), assistantEvent(2, "qq reply"), turnEnd(3)];
  const qqSource = { ...hostSession("q1", qqEvents), header: { agentPreset: "amadeus-qq" } };
  const ordinarySource = {
    ...hostSession("s1", [userEvent(1, "ordinary"), assistantEvent(2, "reply"), turnEnd(3)]),
    header: { agentPreset: "standard" }
  };
  const target = { ...hostSession("s2"), header: { agentPreset: "standard" } };
  const trusted = new Map([["q1", qqSource], ["s1", ordinarySource], ["s2", target]]);
  const ctx = { qq: { resolveTrustedSessionScene: id => id === "q1"
    ? { platform: "qq", botId: "10001", kind: "group", peerId: "20001" }
    : null } };
  const gate = createQQModelAccessGate({
    ctx, config: { sceneIsolationEnabled: false, sceneStrictQQ: false },
    authorizeWorkspace: session => ({ allowed: trusted.has(session?.id), workspaceId: "ws-a" })
  });
  // Synthetic setup writer: records the QQ source and its explicit grant without
  // consulting the model gate. The reads below use the real gateway.
  const setupCore = createRecentActivityCore({
    db, workspaceId: "ws-a", allowSession: () => true,
    resolveTrustedSession: id => trusted.get(id) ?? null
  });
  assert.equal(setupCore.recordTurnEnd(qqSource, endOf(qqEvents, 3), { now: T0 }).ok, true);
  assert.equal(setupCore.setSourcePolicy(qqSource, {
    mode: "shared", sharedSessionIds: ["s2"]
  }).ok, true);

  const core = createRecentActivityCore({
    db, workspaceId: "ws-a", allowSession: gate,
    resolveTrustedSession: id => trusted.get(id) ?? null
  });
  const hidden = core.readRecentActivity(target, { now: T0 + 1 });
  assert.equal(hidden.ok, true);
  assert.equal(hidden.count, 0, "an unverified QQ source is never visible to an ordinary Session");
  assert.equal(core.setSourcePolicy(qqSource, {
    mode: "shared", sharedSessionIds: ["s2"]
  }).ok, false, "a QQ source cannot create a cross-Session grant in default mode");
  assert.equal(core.setSourcePolicy(ordinarySource, {
    mode: "shared", sharedSessionIds: ["q1"]
  }).ok, false, "a QQ target remains isolated even when named by an ordinary source");
  db.close();
});

function registryCtx(workspaces) {
  return { workspaceRegistry: { list: () => workspaces } };
}

function allowFor(workspaces, workspaceId = "ws-a") {
  const ctx = registryCtx(workspaces);
  return (session) => checkWorkspaceAccess(session, workspaceId, ctx);
}

function hostSession(id, events = []) {
  return {
    id,
    events,
    snapshotEvents() { return this.events; }
  };
}

// 10,000 contiguous Host event positions. Only a short suffix is needed for the
// latest completed turn; the older content is a marker that must never leak
// into that turn's summary.
function largeSessionEvents() {
  const events = Array.from({ length: 10_000 }, (_, seq) => ({
    seq,
    type: "plan/update",
    data: { text: `filler event ${seq}` }
  }));
  events[0] = userEvent(0, "ancient topic must not appear");
  events[1] = assistantEvent(1, "ancient answer must not appear");
  events[2] = turnEnd(2);
  events[9993] = userEvent(9993, "stale previous turn topic");
  events[9994] = assistantEvent(9994, "stale previous turn answer");
  events[9995] = turnEnd(9995);
  events[9997] = userEvent(9997, "latest completed turn topic");
  events[9998] = assistantEvent(9998, "latest completed answer");
  events[9999] = turnEnd(9999);
  return events;
}

function userEvent(seq, text, source = { kind: "user" }) {
  return {
    seq,
    type: "user/message",
    data: { source, content: [{ type: "text", text }] }
  };
}

function legacyUserEvent(seq, text) {
  return { seq, type: "user/message", data: { content: [{ type: "text", text }] } };
}

function assistantEvent(seq, content, extra = {}) {
  const blocks = Array.isArray(content) ? content : [{ type: "text", text: content }];
  return {
    seq,
    type: "assistant/message",
    data: { message: { role: "assistant", content: blocks, ...extra } }
  };
}

function toolCall(seq, name = "lookup") {
  return { seq, type: "tool/call", data: { name, arguments: "{}" } };
}

function toolResult(seq, isError = false) {
  return {
    seq,
    type: "tool/result",
    data: { message: { role: "tool", isError, content: [{ type: "text", text: "tool output" }] } }
  };
}

function turnEnd(seq) {
  return { seq, type: "turn/end", data: {} };
}

function endOf(events, seq) {
  return events.find((event) => event.type === "turn/end" && event.seq === seq);
}

function eventCount(db, workspaceId = "ws-a") {
  return Number(db.prepare(
    "SELECT COUNT(*) AS count FROM recent_activity_events WHERE workspace_id = ?"
  ).get(workspaceId)?.count ?? 0);
}

function policyCount(db, workspaceId = "ws-a") {
  return Number(db.prepare(
    "SELECT COUNT(*) AS count FROM recent_activity_source_policy WHERE workspace_id = ?"
  ).get(workspaceId)?.count ?? 0);
}

function rowFor(db, workspaceId, sourceSessionId, turnSeq) {
  return db.prepare(
    `SELECT kind, summary, occurred_at AS occurredAt, expires_at AS expiresAt
     FROM recent_activity_events
     WHERE workspace_id = ? AND source_session_id = ? AND turn_seq = ?`
  ).get(workspaceId, sourceSessionId, turnSeq);
}

function baseWorkspaces() {
  return [
    { id: "ws-a", title: "A", sessionIds: ["s1", "s2", "s3", "owner-1"] },
    { id: "ws-b", title: "B", sessionIds: [] }
  ];
}

test("default self policy, safe DTO, explicit self query, and no memories writes", () => {
  const path = tempDbPath();
  const db = openDatabase(path);
  db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL
    );
    INSERT INTO memories VALUES ('m1', 'long-term', 'must stay untouched');
  `);
  const core = createRecentActivityCore({
    db,
    workspaceId: "ws-a",
    allowSession: () => true
  });
  const events = [
    userEvent(1, "hello recent core"),
    assistantEvent(2, "hello back"),
    turnEnd(3)
  ];
  const s1 = hostSession("s1", events);
  const recorded = core.recordTurnEnd(s1, endOf(events, 3), { now: T0 });
  assert.equal(recorded.ok, true);
  assert.equal(recorded.kind, "conversation");

  const s2 = hostSession("s2");
  const cross = core.readRecentActivity(s2, { now: T0 + 1 });
  assert.equal(cross.ok, true);
  assert.equal(cross.count, 0, "cross-Session reads default to self-only");

  const self = core.readRecentActivity(s1, { now: T0 + 1, sources: ["s1"] });
  assert.equal(self.ok, true);
  assert.equal(self.count, 1);
  assert.equal(self.items[0].sourceSessionId, "s1");
  assert.equal(self.items[0].kind, "conversation");
  assert.match(self.items[0].summary, /hello recent core/);
  assert.match(self.items[0].summary, /hello back/);
  assert.equal(self.items[0].estimatedTokens, estimateRecentActivityTokens(self.items[0].summary) + 8);
  assert.equal(self.estimatedTokens, self.items[0].estimatedTokens);
  assert.deepEqual(
    Object.keys(self.items[0]).sort(),
    ["estimatedTokens", "kind", "occurredAt", "sourceSessionId", "summary"]
  );
  assert.deepEqual(
    Object.keys(self).sort(),
    ["count", "estimatedTokens", "items", "ok", "reason", "truncated"]
  );

  const memories = db.prepare("SELECT id, title, content FROM memories").all();
  assert.equal(memories.length, 1);
  assert.equal(memories[0].content, "must stay untouched");
  assert.equal(core.getSourcePolicy(s1).mode, "self");
  db.close();

  // A database that never had a memories table must not get one.
  const cleanPath = tempDbPath();
  const cleanDb = openDatabase(cleanPath);
  const cleanCore = createRecentActivityCore({
    db: cleanDb,
    workspaceId: "ws-a",
    allowSession: () => true
  });
  const cleanEvents = [
    userEvent(1, "only recent"),
    assistantEvent(2, "only answer"),
    turnEnd(3)
  ];
  const cleanSession = hostSession("s1", cleanEvents);
  assert.equal(cleanCore.recordTurnEnd(cleanSession, endOf(cleanEvents, 3), { now: T0 }).ok, true);
  assert.equal(cleanDb.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'memories'"
  ).get().count, 0);
  const tables = cleanDb.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'recent_activity_%' ORDER BY name"
  ).all().map((row) => row.name);
  assert.deepEqual(tables, ["recent_activity_events", "recent_activity_source_policy"]);
  cleanDb.close();
});

test("shared allowlist, immediate revoke, moved source/target, and self query", () => {
  const path = tempDbPath();
  const db = openDatabase(path);
  const workspaces = baseWorkspaces();
  const allowSession = allowFor(workspaces);
  const core = createRecentActivityCore({ db, workspaceId: "ws-a", allowSession });

  const events = [
    userEvent(1, "first question"),
    assistantEvent(2, "first answer"),
    turnEnd(3),
    userEvent(4, "second question"),
    assistantEvent(5, "second answer"),
    turnEnd(6)
  ];
  const s1 = hostSession("s1", events);
  assert.equal(core.recordTurnEnd(s1, endOf(events, 3), { now: T0 }).ok, true);
  assert.equal(core.recordTurnEnd(s1, endOf(events, 6), { now: T0 + 1000 }).ok, true);

  const s2 = hostSession("s2");
  assert.equal(core.readRecentActivity(s2, { now: T0 + 2000 }).count, 0);

  const shared = core.setSourcePolicy(s1, {
    mode: "shared",
    sharedSessionIds: ["s2", "s2", "s3"]
  });
  assert.deepEqual(shared, {
    ok: true,
    mode: "shared",
    sharedSessionIds: ["s2", "s3"],
    enabled: true
  });
  assert.equal(core.readRecentActivity(s2, { now: T0 + 2000 }).count, 2);

  assert.equal(core.setSourcePolicy(s1, { mode: "self" }).ok, true);
  assert.equal(
    core.readRecentActivity(s2, { now: T0 + 2000 }).count,
    0,
    "revocation affects the very next read"
  );

  assert.equal(core.setSourcePolicy(s1, {
    mode: "shared",
    sharedSessionIds: ["s2"]
  }).ok, true);
  assert.equal(core.readRecentActivity(s2, { now: T0 + 2000 }).count, 2);

  // Explicit self query works without any cross-Session grant.
  const self = core.readRecentActivity(s1, { now: T0 + 2000, sources: ["s1"] });
  assert.equal(self.count, 2);
  assert.equal(self.items.every((item) => item.sourceSessionId === "s1"), true);
  assert.equal(core.readRecentActivity(s1, {
    now: T0 + 2000,
    sources: ["s1"],
    includeSelf: false
  }).count, 0);

  // Moved target: denied before any read.
  workspaces[0].sessionIds = ["s1", "s3", "owner-1"];
  workspaces[1].sessionIds = ["s2"];
  const movedTarget = core.readRecentActivity(s2, { now: T0 + 2000 });
  assert.equal(movedTarget.ok, false);
  assert.equal(movedTarget.reason, "workspace-mismatch");
  assert.equal(movedTarget.count, 0);

  // Moved source: the target is authorized, but the stored source is no longer
  // a member of the active Workspace, so its events are omitted.
  workspaces[0].sessionIds = ["s2", "s3", "owner-1"];
  workspaces[1].sessionIds = ["s1"];
  assert.equal(core.readRecentActivity(s2, { now: T0 + 2000 }).count, 0);

  workspaces[0].sessionIds = ["s1", "s2", "s3", "owner-1"];
  workspaces[1].sessionIds = [];
  assert.equal(core.readRecentActivity(s2, { now: T0 + 2000 }).count, 2);
  db.close();
});

test("owner mode requires the Host-authenticated callback and never trusts session metadata", () => {
  const path = tempDbPath();
  const db = openDatabase(path);
  const workspaces = baseWorkspaces();
  const allowSession = allowFor(workspaces);
  const seenOwners = [];
  const isTrustedOwner = (session) => {
    seenOwners.push(session);
    return session.id === "owner-1";
  };

  let core = createRecentActivityCore({ db, workspaceId: "ws-a", allowSession, isTrustedOwner });
  const events = [
    userEvent(1, "owner-only recent"),
    assistantEvent(2, "owner-only answer"),
    turnEnd(3)
  ];
  const s1 = hostSession("s1", events);
  assert.equal(core.recordTurnEnd(s1, endOf(events, 3), { now: T0 }).ok, true);
  assert.equal(core.setSourcePolicy(s1, { mode: "owner" }).ok, true);

  const impersonator = hostSession("s2");
  impersonator.name = "owner-1";
  impersonator.title = "owner";
  impersonator.preset = "owner";
  impersonator.model = "owner";
  assert.equal(core.readRecentActivity(impersonator, { now: T0 + 1 }).count, 0);
  assert.equal(seenOwners.at(-1), impersonator, "callback receives the actual target Session");

  const owner = hostSession("owner-1");
  const ownerRead = core.readRecentActivity(owner, { now: T0 + 1 });
  assert.equal(ownerRead.count, 1);
  assert.equal(ownerRead.items[0].summary.includes("owner-only recent"), true);

  // Replacing the trusted callback with one that distrusts every target also
  // denies: the core never invents its own authority from session metadata.
  const fieldOnly = createRecentActivityCore({
    db,
    workspaceId: "ws-a",
    allowSession,
    isTrustedOwner: () => false
  });
  assert.equal(fieldOnly.readRecentActivity(impersonator, { now: T0 + 1 }).count, 0);

  // The default callback is false and a throwing callback fails closed.
  const defaultOwner = createRecentActivityCore({ db, workspaceId: "ws-a", allowSession });
  assert.equal(defaultOwner.readRecentActivity(owner, { now: T0 + 1 }).count, 0);
  const throwingOwner = createRecentActivityCore({
    db,
    workspaceId: "ws-a",
    allowSession,
    isTrustedOwner: () => { throw new Error("host failed"); }
  });
  assert.equal(throwingOwner.readRecentActivity(owner, { now: T0 + 1 }).count, 0);

  // A moved owner is still denied by the active Workspace gate.
  workspaces[0].sessionIds = ["s1", "s2", "s3"];
  workspaces[1].sessionIds = ["owner-1"];
  const moved = core.readRecentActivity(owner, { now: T0 + 1 });
  assert.equal(moved.ok, false);
  assert.equal(moved.reason, "workspace-mismatch");

  workspaces[0].sessionIds = ["s1", "s2", "s3", "owner-1"];
  workspaces[1].sessionIds = [];
  assert.equal(core.readRecentActivity(owner, { now: T0 + 1 }).count, 1);
  assert.equal(core.setSourcePolicy(s1, { mode: "self" }).ok, true);
  assert.equal(core.readRecentActivity(owner, { now: T0 + 1 }).count, 0);
  db.close();
});

test("duplicate turn/end is deduplicated and events/policy survive a restart", () => {
  const path = tempDbPath();
  let db = new DatabaseSync(path);
  const events = [
    userEvent(10, "persist this turn"),
    assistantEvent(11, "persist this answer"),
    turnEnd(12)
  ];
  const s1 = hostSession("s1", events);
  let core = createRecentActivityCore({ db, workspaceId: "ws-a", allowSession: () => true });
  assert.equal(core.recordTurnEnd(s1, endOf(events, 12), { now: T0 }).ok, true);
  assert.equal(core.recordTurnEnd(s1, endOf(events, 12), { now: T0 + 1 }).reason, "duplicate");
  assert.equal(eventCount(db), 1);
  assert.equal(core.setSourcePolicy(s1, {
    mode: "shared",
    sharedSessionIds: ["s2"]
  }).ok, true);
  db.close();

  db = new DatabaseSync(path);
  core = createRecentActivityCore({ db, workspaceId: "ws-a", allowSession: () => true });
  const s2 = hostSession("s2");
  const read = core.readRecentActivity(s2, { now: T0 + 2 });
  assert.equal(read.ok, true);
  assert.equal(read.count, 1, "events persist across restart");
  assert.match(read.items[0].summary, /persist this turn/);
  assert.deepEqual(core.getSourcePolicy(s1), {
    ok: true,
    mode: "shared",
    sharedSessionIds: ["s2"],
    enabled: true
  });
  assert.equal(core.recordTurnEnd(s1, endOf(events, 12), { now: T0 + 3 }).reason, "duplicate");
  assert.equal(eventCount(db), 1);
  db.close();
});

test("TTL selection expires and deletes retained events", () => {
  const path = tempDbPath();
  const db = openDatabase(path);
  const core = createRecentActivityCore({
    db,
    workspaceId: "ws-a",
    allowSession: () => true,
    config: { ttlHours: 1 }
  });
  assert.equal(core.getConfig().ttlHours, 1);
  for (const ttl of RECENT_ACTIVITY_LIMITS.TTL_HOURS) {
    assert.equal(core.configure({ ttlHours: ttl }).ttlHours, ttl);
  }
  core.configure({ ttlHours: 1 });

  const events = [
    userEvent(1, "expiring question"),
    assistantEvent(2, "expiring answer"),
    turnEnd(3)
  ];
  const s1 = hostSession("s1", events);
  assert.equal(core.recordTurnEnd(s1, endOf(events, 3), { now: T0 }).ok, true);
  const row = rowFor(db, "ws-a", "s1", 3);
  assert.equal(row.expiresAt, T0 + HOUR);
  assert.equal(core.readRecentActivity(s1, { now: T0 + HOUR - 1 }).count, 1);
  assert.equal(core.readRecentActivity(s1, { now: T0 + HOUR + 1 }).count, 0);
  assert.equal(eventCount(db), 0, "expired rows are deleted on an authorized read");
  db.close();
});

test("untrusted, unfinished, reasoning, tool-call-only and error turns are excluded or downgraded", () => {
  const path = tempDbPath();
  const db = openDatabase(path);
  const core = createRecentActivityCore({ db, workspaceId: "ws-a", allowSession: () => true });

  const events = [
    userEvent(1, "public question one"),
    userEvent(2, "plugin injection secret", { kind: "plugin", plugin: "dsh-mneme" }),
    userEvent(3, "subagent secret", { kind: "subagent" }),
    { seq: 4, type: "plan/update", data: { text: "unfinished plan text" } },
    assistantEvent(5, [
      { type: "text", text: "public answer one" },
      { type: "reasoning", text: "private reasoning chain" }
    ]),
    toolCall(6),
    turnEnd(7),

    userEvent(8, "tool call only question"),
    toolCall(9),
    assistantEvent(10, "tool call only answer"),
    turnEnd(11),

    userEvent(12, "completed action question"),
    toolCall(13),
    toolResult(14, false),
    assistantEvent(15, "completed action answer"),
    turnEnd(16),

    userEvent(17, "failed action question"),
    toolCall(18),
    toolResult(19, true),
    assistantEvent(20, "pending plan text", { status: "pending" }),
    assistantEvent(21, "failed action answer"),
    turnEnd(22)
  ];
  const s1 = hostSession("s1", events);
  for (const seq of [7, 11, 16, 22]) {
    assert.equal(core.recordTurnEnd(s1, endOf(events, seq), { now: T0 + seq }).ok, true);
  }

  const first = rowFor(db, "ws-a", "s1", 7);
  assert.equal(first.kind, "conversation");
  assert.match(first.summary, /public question one/);
  assert.match(first.summary, /public answer one/);
  assert.equal(first.summary.includes("plugin injection secret"), false);
  assert.equal(first.summary.includes("subagent secret"), false);
  assert.equal(first.summary.includes("unfinished plan text"), false);
  assert.equal(first.summary.includes("private reasoning chain"), false);
  assert.equal(first.summary.includes("tool output"), false);

  assert.equal(rowFor(db, "ws-a", "s1", 11).kind, "conversation",
    "a tool/call without a result never becomes agent_action");
  assert.equal(rowFor(db, "ws-a", "s1", 16).kind, "agent_action");
  assert.equal(rowFor(db, "ws-a", "s1", 22).kind, "conversation");

  const failedSummary = rowFor(db, "ws-a", "s1", 22).summary;
  assert.equal(failedSummary.includes("pending plan text"), false);
  assert.match(failedSummary, /failed action answer/);

  const countBefore = eventCount(db);
  assert.equal(core.recordTurnEnd(s1, { type: "turn/end", data: {} }, { now: T0 }).reason,
    "missing-event-sequence");
  assert.equal(core.recordTurnEnd(s1, { seq: 30, type: "user/message" }, { now: T0 }).reason,
    "not-turn-end");
  assert.equal(eventCount(db), countBefore);

  // Legacy user events with no source are public; a turn without any public
  // text is not recorded.
  const legacyEvents = [
    legacyUserEvent(1, "legacy user text"),
    { seq: 2, type: "assistant/message", data: { message: { content: [{ type: "reasoning", text: "only private" }] } } },
    turnEnd(3)
  ];
  const legacy = hostSession("legacy", legacyEvents);
  assert.equal(core.recordTurnEnd(legacy, endOf(legacyEvents, 3), { now: T0 }).ok, true);
  assert.match(rowFor(db, "ws-a", "legacy", 3).summary, /legacy user text/);

  const emptyEvents = [
    userEvent(1, "plugin-only user text", { kind: "plugin", plugin: "other" }),
    { seq: 2, type: "assistant/message", data: { message: { content: [{ type: "reasoning", text: "private only" }] } } },
    turnEnd(3)
  ];
  const empty = hostSession("empty", emptyEvents);
  assert.equal(core.recordTurnEnd(empty, endOf(emptyEvents, 3), { now: T0 }).reason,
    "no-public-text");
  db.close();
});

test("malformed user sources and tool results without explicit success evidence fail closed", () => {
  const path = tempDbPath();
  const db = openDatabase(path);
  const core = createRecentActivityCore({ db, workspaceId: "ws-a", allowSession: () => true });

  const events = [
    userEvent(1, "valid topic for bounded summary"),
    // A present source must be an explicit user object. A string, an array and
    // an object without kind are all malformed and must not be public.
    userEvent(2, "string source secret", "plugin"),
    userEvent(3, "kindless source secret", { plugin: "dsh-mneme" }),
    userEvent(4, "array source secret", []),
    assistantEvent(5, "valid outcome snippet"),
    turnEnd(6),

    userEvent(7, "ambiguous newer result topic"),
    toolCall(8),
    {
      seq: 9,
      type: "tool/result",
      data: { message: { role: "tool", content: [{ type: "text", text: "tool output" }] } }
    },
    assistantEvent(10, "ambiguous newer result answer"),
    turnEnd(11),

    userEvent(12, "ambiguous legacy result topic"),
    toolCall(13),
    {
      seq: 14,
      type: "tool/result",
      data: { message: { content: [{ type: "tool-result", output: "tool output" }] } }
    },
    assistantEvent(15, "ambiguous legacy result answer"),
    turnEnd(16),

    userEvent(17, "ambiguous code dispatch topic"),
    {
      seq: 18,
      type: "tool/code-dispatch",
      data: { content: [{ type: "text", text: "tool output" }] }
    },
    assistantEvent(19, "ambiguous code dispatch answer"),
    turnEnd(20),

    userEvent(21, "explicit non-error result topic"),
    toolCall(22),
    toolResult(23, false),
    assistantEvent(24, "explicit non-error result answer"),
    turnEnd(25),

    userEvent(26, "only malformed source", "plugin"),
    turnEnd(27)
  ];
  const session = hostSession("s1", events);
  for (const seq of [6, 11, 16, 20, 25]) {
    assert.equal(core.recordTurnEnd(session, endOf(events, seq), { now: T0 + seq }).ok, true);
  }

  const first = rowFor(db, "ws-a", "s1", 6);
  assert.match(first.summary, /valid topic for bounded summary/);
  assert.match(first.summary, /valid outcome snippet/);
  for (const secret of [
    "string source secret",
    "kindless source secret",
    "array source secret",
    "tool output"
  ]) {
    assert.equal(first.summary.includes(secret), false);
  }

  assert.equal(rowFor(db, "ws-a", "s1", 11).kind, "conversation",
    "a tool result with no explicit isError cannot support agent_action");
  assert.equal(rowFor(db, "ws-a", "s1", 16).kind, "conversation",
    "a legacy tool-result block with no explicit isError cannot support agent_action");
  assert.equal(rowFor(db, "ws-a", "s1", 20).kind, "conversation",
    "a code-dispatch record with no explicit isError cannot support agent_action");
  assert.equal(rowFor(db, "ws-a", "s1", 25).kind, "agent_action",
    "an explicit non-error tool result still supports agent_action");

  assert.equal(core.recordTurnEnd(session, endOf(events, 27), { now: T0 }).reason,
    "no-public-text", "a turn containing only a malformed-source message is not recorded");
  db.close();
});

test("text, item, token, per-Session and global row limits are enforced", () => {
  const path = tempDbPath();
  const db = openDatabase(path);
  const core = createRecentActivityCore({ db, workspaceId: "ws-a", allowSession: () => true });

  const hugeUser = `long-user-${"u".repeat(1200)}-user-tail-marker`;
  const hugeAssistant = `long-assistant-${"a".repeat(1400)}-assistant-tail-marker`;
  const hugeEvents = [userEvent(1, hugeUser), assistantEvent(2, hugeAssistant), turnEnd(3)];
  const hugeSession = hostSession("huge", hugeEvents);
  assert.equal(core.recordTurnEnd(hugeSession, endOf(hugeEvents, 3), { now: T0 }).ok, true);
  const hugeRow = rowFor(db, "ws-a", "huge", 3);
  assert.ok(hugeRow.summary.length <= RECENT_ACTIVITY_LIMITS.MAX_SUMMARY_CHARS);
  assert.equal(hugeRow.summary.includes("user-tail-marker"), false,
    "the long user message is not stored verbatim");
  assert.equal(hugeRow.summary.includes("assistant-tail-marker"), false,
    "the long assistant message is not stored verbatim");
  assert.equal(hugeRow.summary.includes(hugeUser.slice(0, 200)), false,
    "only a bounded topic snippet is stored");
  assert.equal(hugeRow.summary.includes(hugeAssistant.slice(0, 200)), false,
    "only a bounded outcome snippet is stored");
  const hugeRead = core.readRecentActivity(hugeSession, { now: T0 + 1, maxItems: 10 });
  assert.ok(hugeRead.items[0].summary.length <= RECENT_ACTIVITY_LIMITS.MAX_SUMMARY_CHARS);
  assert.equal(hugeRead.items[0].summary.includes("user-tail-marker"), false);
  assert.equal(hugeRead.items[0].summary.includes("assistant-tail-marker"), false);
  assert.equal(hugeRead.items[0].summary.includes(hugeAssistant.slice(0, 200)), false);

  // Eight turns with medium answers; default maxItems is 3.
  const mediumEvents = [];
  for (let index = 0; index < 8; index += 1) {
    const base = 1 + index * 3;
    mediumEvents.push(
      userEvent(base, `question ${index}`),
      assistantEvent(base + 1, `answer ${index} ${"a".repeat(100)}`),
      turnEnd(base + 2)
    );
  }
  const medium = hostSession("medium", mediumEvents);
  for (let index = 0; index < 8; index += 1) {
    const seq = 3 + index * 3;
    assert.equal(core.recordTurnEnd(medium, endOf(mediumEvents, seq), { now: T0 + 10 + index }).ok, true);
  }
  const defaultRead = core.readRecentActivity(medium, { now: T0 + 100 });
  assert.equal(defaultRead.count, 3, "default injected item limit is three");

  core.configure({ maxItems: 10, maxTokens: 100 });
  const budgetRead = core.readRecentActivity(medium, { now: T0 + 100 });
  assert.ok(budgetRead.count < 8);
  assert.ok(budgetRead.estimatedTokens <= 100);
  assert.equal(
    budgetRead.estimatedTokens,
    budgetRead.items.reduce((sum, item) => sum + item.estimatedTokens, 0)
  );
  assert.equal(budgetRead.truncated, true);
  core.configure({ maxItems: 1, maxTokens: 800 });
  assert.equal(core.readRecentActivity(medium, { now: T0 + 100 }).count, 1);

  // One noisy Session retains at most 50 newest turns.
  const manyEvents = [];
  for (let index = 0; index < 60; index += 1) {
    const base = 1 + index * 3;
    manyEvents.push(
      userEvent(base, `many question ${index}`),
      assistantEvent(base + 1, `many answer ${index}`),
      turnEnd(base + 2)
    );
  }
  const many = hostSession("many", manyEvents);
  for (let index = 0; index < 60; index += 1) {
    const seq = 3 + index * 3;
    assert.equal(core.recordTurnEnd(many, endOf(manyEvents, seq), { now: T0 + 200 + index }).ok, true);
  }
  const manyCount = Number(db.prepare(
    "SELECT COUNT(*) AS count FROM recent_activity_events WHERE workspace_id = ? AND source_session_id = ?"
  ).get("ws-a", "many").count);
  assert.equal(manyCount, RECENT_ACTIVITY_LIMITS.MAX_EVENTS_PER_SESSION);
  assert.equal(rowFor(db, "ws-a", "many", 3), undefined, "oldest per-Session row was evicted");
  assert.ok(rowFor(db, "ws-a", "many", 180));

  // Eleven Sessions x 50 rows would be 550; the global cap holds at 500.
  for (let sessionIndex = 0; sessionIndex < 11; sessionIndex += 1) {
    const events = [];
    for (let index = 0; index < 50; index += 1) {
      const base = 1 + index * 3;
      events.push(
        userEvent(base, `global ${sessionIndex}/${index}`),
        assistantEvent(base + 1, `global answer ${sessionIndex}/${index}`),
        turnEnd(base + 2)
      );
    }
    const session = hostSession(`global-${sessionIndex}`, events);
    for (let index = 0; index < 50; index += 1) {
      const seq = 3 + index * 3;
      const result = core.recordTurnEnd(session, endOf(events, seq), {
        now: T0 + 10_000 + sessionIndex * 1000 + index
      });
      assert.equal(result.ok, true);
    }
  }
  assert.equal(eventCount(db), RECENT_ACTIVITY_LIMITS.MAX_EVENTS_TOTAL);
  db.close();
});

test("gate runs before reads and is rechecked before commit; absent callbacks fail closed", () => {
  const path = tempDbPath();
  const db = openDatabase(path);
  let calls = 0;
  let snapshotReads = 0;
  const events = [
    userEvent(1, "gate question"),
    assistantEvent(2, "gate answer"),
    turnEnd(3)
  ];
  const session = {
    id: "s1",
    get events() { return events; },
    snapshotEvents() { snapshotReads += 1; return events; }
  };
  const togglingCore = createRecentActivityCore({
    db,
    workspaceId: "ws-a",
    allowSession: () => {
      calls += 1;
      return calls === 1
        ? { allowed: true, reason: "ok" }
        : { allowed: false, reason: "revoked-before-commit" };
    }
  });
  const denied = togglingCore.recordTurnEnd(session, endOf(events, 3), { now: T0 });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "revoked-before-commit");
  assert.equal(calls, 2);
  assert.equal(snapshotReads, 1, "the first gate allowed the snapshot read");
  assert.equal(eventCount(db), 0, "the recheck rolled the write back");

  // A denied target read performs no expiry maintenance or storage read.
  const mutable = { allowed: true };
  const readCore = createRecentActivityCore({
    db,
    workspaceId: "ws-a",
    allowSession: () => mutable.allowed,
    config: { ttlHours: 1 }
  });
  const readEvents = [
    userEvent(1, "expire later"),
    assistantEvent(2, "expire later answer"),
    turnEnd(3)
  ];
  const readSession = hostSession("s1", readEvents);
  assert.equal(readCore.recordTurnEnd(readSession, endOf(readEvents, 3), { now: T0 }).ok, true);
  mutable.allowed = false;
  const deniedRead = readCore.readRecentActivity(readSession, { now: T0 + 2 * HOUR });
  assert.equal(deniedRead.ok, false);
  assert.equal(deniedRead.reason, "access-denied");
  assert.equal(eventCount(db), 1, "a denied read did not prune");
  mutable.allowed = true;
  assert.equal(readCore.readRecentActivity(readSession, { now: T0 + 2 * HOUR }).count, 0);
  assert.equal(eventCount(db), 0, "an authorized read prunes expired rows");

  const missing = createRecentActivityCore({ db, workspaceId: "ws-a" });
  assert.equal(missing.status().ok, true);
  assert.equal(missing.recordTurnEnd(session, endOf(events, 3), { now: T0 }).reason,
    "access-check-unavailable");
  assert.equal(missing.readRecentActivity(session, { now: T0 }).ok, false);

  const unavailable = createRecentActivityCore({
    db: null,
    workspaceId: "ws-a",
    allowSession: () => true
  });
  assert.equal(unavailable.status().ok, false);
  assert.doesNotThrow(() => unavailable.recordTurnEnd(session, endOf(events, 3), { now: T0 }));
  assert.equal(unavailable.recordTurnEnd(session, endOf(events, 3), { now: T0 }).ok, false);

  const throwing = createRecentActivityCore({
    db,
    workspaceId: "ws-a",
    allowSession: () => { throw new Error("host"); }
  });
  assert.equal(throwing.recordTurnEnd(session, endOf(events, 3), { now: T0 }).reason,
    "access-check-failed");
  db.close();
});

test("policy validation is bounded and unauthorized sources cannot persist policy", () => {
  const path = tempDbPath();
  const db = openDatabase(path);
  const workspaces = baseWorkspaces();
  const allowSession = allowFor(workspaces);
  const core = createRecentActivityCore({ db, workspaceId: "ws-a", allowSession });
  const s1 = hostSession("s1");

  assert.equal(core.setSourcePolicy(s1, { mode: "everyone" }).reason, "invalid-policy");
  assert.equal(core.setSourcePolicy(s1, { mode: "shared", sharedSessionIds: "s2" }).reason,
    "invalid-policy");
  assert.equal(core.setSourcePolicy(s1, { mode: "shared", sharedSessionIds: [1] }).reason,
    "invalid-policy");
  assert.equal(core.setSourcePolicy(s1, {
    mode: "shared",
    sharedSessionIds: ["x".repeat(RECENT_ACTIVITY_LIMITS.MAX_ID_CHARS + 1)]
  }).reason, "invalid-policy");
  const tooMany = Array.from({ length: RECENT_ACTIVITY_LIMITS.MAX_SHARED_TARGETS + 1 },
    (_, index) => `share-${index}`);
  assert.equal(core.setSourcePolicy(s1, { mode: "shared", sharedSessionIds: tooMany }).reason,
    "invalid-policy");
  assert.deepEqual(core.getSourcePolicy(s1), {
    ok: true,
    mode: "self",
    sharedSessionIds: [],
    enabled: true
  });

  // A GUI cannot pre-authorize a target from another Workspace (or an unknown
  // Session); the rejected write must not leave a partial allowlist behind.
  workspaces[1].sessionIds = ["outside"];
  assert.deepEqual(core.setSourcePolicy(s1, {
    mode: "shared",
    sharedSessionIds: ["s2", "outside"]
  }), { ok: false, reason: "workspace-mismatch" });
  assert.deepEqual(core.getSourcePolicy(s1), {
    ok: true,
    mode: "self",
    sharedSessionIds: [],
    enabled: true
  });
  assert.deepEqual(core.setSourcePolicy(s1, {
    mode: "shared",
    sharedSessionIds: ["ghost"]
  }), { ok: false, reason: "session-not-found" });
  assert.deepEqual(core.getSourcePolicy(s1), {
    ok: true,
    mode: "self",
    sharedSessionIds: [],
    enabled: true
  });

  assert.equal(core.setSourcePolicy(hostSession("not-a-member"), {
    mode: "shared",
    sharedSessionIds: ["s1"]
  }).ok, false, "an unauthorized source Session cannot write policy");
  assert.equal(core.setSourcePolicy(hostSession("outside"), {
    mode: "shared",
    sharedSessionIds: ["s1"]
  }).ok, false);

  assert.deepEqual(core.setSourcePolicy(s1, {
    mode: "shared",
    sharedSessionIds: ["s2", "s2"]
  }), {
    ok: true,
    mode: "shared",
    sharedSessionIds: ["s2"],
    enabled: true
  });
  assert.deepEqual(core.getSourcePolicy(s1), {
    ok: true,
    mode: "shared",
    sharedSessionIds: ["s2"],
    enabled: true
  });
  assert.deepEqual(core.setSourcePolicy(s1, {
    mode: "shared",
    sharedSessionIds: ["s2", "outside"]
  }), { ok: false, reason: "workspace-mismatch" });
  assert.deepEqual(core.getSourcePolicy(s1), {
    ok: true,
    mode: "shared",
    sharedSessionIds: ["s2"],
    enabled: true
  }, "a rejected target leaves the existing shared policy unchanged");
  workspaces[1].sessionIds = [];
  assert.deepEqual(core.setSourcePolicy(s1, {
    mode: "self",
    sharedSessionIds: ["ignored"]
  }), {
    ok: true,
    mode: "self",
    sharedSessionIds: [],
    enabled: true
  });
  db.close();
});

test("read time range, query, source filters and invalid options are bounded", () => {
  const db = openDatabase(tempDbPath());
  const core = createRecentActivityCore({
    db,
    workspaceId: "ws-a",
    allowSession: () => true
  });
  const events = [
    userEvent(1, "alpha question"),
    assistantEvent(2, "alpha answer"),
    turnEnd(3),
    userEvent(4, "beta question"),
    assistantEvent(5, "beta answer"),
    turnEnd(6)
  ];
  const session = hostSession("s1", events);
  assert.equal(core.recordTurnEnd(session, endOf(events, 3), { now: T0 }).ok, true);
  assert.equal(core.recordTurnEnd(session, endOf(events, 6), { now: T0 + 1000 }).ok, true);

  const since = core.readRecentActivity(session, { now: T0 + 2000, since: T0 + 500 });
  assert.equal(since.count, 1);
  assert.match(since.items[0].summary, /beta question/);

  const until = core.readRecentActivity(session, { now: T0 + 2000, until: T0 + 500 });
  assert.equal(until.count, 1);
  assert.match(until.items[0].summary, /alpha question/);

  assert.equal(core.readRecentActivity(session, { now: T0 + 2000, query: "ALPHA" }).count, 1);
  assert.equal(core.readRecentActivity(session, { now: T0 + 2000, query: "beta answer" }).count, 1);
  assert.equal(core.readRecentActivity(session, { now: T0 + 2000, query: "gamma" }).count, 0);

  const emptyFilter = core.readRecentActivity(session, { now: T0 + 2000, sources: [] });
  assert.equal(emptyFilter.ok, true);
  assert.equal(emptyFilter.count, 0);
  const invertedRange = core.readRecentActivity(session, {
    now: T0 + 2000,
    since: T0 + 5000,
    until: T0
  });
  assert.equal(invertedRange.ok, true);
  assert.equal(invertedRange.count, 0);

  assert.equal(core.readRecentActivity(session, { now: T0 + 2000, query: 42 }).reason,
    "invalid-query");
  assert.equal(core.readRecentActivity(session, { now: T0 + 2000, sources: "s1" }).reason,
    "invalid-source-filter");
  assert.equal(core.readRecentActivity(session, { now: T0 + 2000, since: "not-a-time" }).reason,
    "invalid-time-range");
  db.close();
});

test("workspace_id namespaces events on a shared physical database", () => {
  const db = openDatabase(tempDbPath());
  const allowSession = () => true;
  const coreA = createRecentActivityCore({ db, workspaceId: "ws-a", allowSession });
  const coreB = createRecentActivityCore({ db, workspaceId: "ws-b", allowSession });
  const events = [
    userEvent(1, "same seq in two workspaces"),
    assistantEvent(2, "same answer"),
    turnEnd(3)
  ];
  const session = hostSession("s1", events);
  assert.equal(coreA.recordTurnEnd(session, endOf(events, 3), { now: T0 }).ok, true);
  assert.equal(coreB.recordTurnEnd(session, endOf(events, 3), { now: T0 }).ok, true);
  assert.equal(eventCount(db, "ws-a"), 1);
  assert.equal(eventCount(db, "ws-b"), 1);

  assert.equal(coreA.readRecentActivity(session, { now: T0 + 1 }).count, 1);
  assert.equal(coreB.readRecentActivity(session, { now: T0 + 1 }).count, 1);
  assert.equal(coreA.readRecentActivity(session, { now: T0 + 1 }).items[0].summary,
    coreB.readRecentActivity(session, { now: T0 + 1 }).items[0].summary);
  db.close();
});

test("enabled policy defaults true, validates booleans, preserves when omitted and restarts", () => {
  const path = tempDbPath();
  let db = openDatabase(path);
  let core = createRecentActivityCore({ db, workspaceId: "ws-a", allowSession: () => true });
  const s1 = hostSession("s1");

  assert.deepEqual(core.getSourcePolicy(s1), {
    ok: true,
    mode: "self",
    sharedSessionIds: [],
    enabled: true
  });

  for (const invalid of ["false", 1, 0, null, {}, []]) {
    assert.equal(
      core.setSourcePolicy(s1, { mode: "self", enabled: invalid }).reason,
      "invalid-policy",
      `enabled ${JSON.stringify(invalid)} is not an explicit boolean`
    );
  }
  assert.equal(core.getSourcePolicy(s1).enabled, true, "rejected writes left the default");

  assert.deepEqual(core.setSourcePolicy(s1, {
    mode: "shared",
    sharedSessionIds: ["s2"],
    enabled: false
  }), {
    ok: true,
    mode: "shared",
    sharedSessionIds: ["s2"],
    enabled: false
  });

  // Omitting enabled preserves false while the mode changes.
  assert.deepEqual(core.setSourcePolicy(s1, { mode: "owner" }), {
    ok: true,
    mode: "owner",
    sharedSessionIds: [],
    enabled: false
  });

  // All three modes remain available, and an explicit true re-enables.
  assert.deepEqual(core.setSourcePolicy(s1, { mode: "self", enabled: true }), {
    ok: true,
    mode: "self",
    sharedSessionIds: [],
    enabled: true
  });
  db.close();

  db = openDatabase(path);
  core = createRecentActivityCore({ db, workspaceId: "ws-a", allowSession: () => true });
  assert.deepEqual(core.getSourcePolicy(s1), {
    ok: true,
    mode: "self",
    sharedSessionIds: [],
    enabled: true
  });
  assert.equal(core.setSourcePolicy(s1, { mode: "owner", enabled: false }).ok, true);
  db.close();

  db = openDatabase(path);
  core = createRecentActivityCore({ db, workspaceId: "ws-a", allowSession: () => true });
  assert.deepEqual(core.getSourcePolicy(s1), {
    ok: true,
    mode: "owner",
    sharedSessionIds: [],
    enabled: false
  }, "the enabled switch persists across restart");
  db.close();
});

test("disabled Source skips transcript collection, denies self reads, hides shared previews and expires normally", () => {
  const db = openDatabase(tempDbPath());
  const core = createRecentActivityCore({
    db,
    workspaceId: "ws-a",
    allowSession: () => true,
    config: { ttlHours: 1 }
  });
  const events = [
    userEvent(1, "before disable topic"),
    assistantEvent(2, "before disable answer"),
    turnEnd(3)
  ];
  const s1 = hostSession("s1", events);
  assert.equal(core.recordTurnEnd(s1, endOf(events, 3), { now: T0 }).ok, true);

  const s2 = hostSession("s2");
  assert.deepEqual(core.setSourcePolicy(s1, {
    mode: "shared",
    sharedSessionIds: ["s2"],
    enabled: true
  }), {
    ok: true,
    mode: "shared",
    sharedSessionIds: ["s2"],
    enabled: true
  });
  assert.equal(core.readRecentActivity(s2, { now: T0 + 1 }).count, 1);

  // The allowlist is retained while the independent enabled switch is off.
  assert.deepEqual(core.setSourcePolicy(s1, {
    mode: "shared",
    sharedSessionIds: ["s2"],
    enabled: false
  }), {
    ok: true,
    mode: "shared",
    sharedSessionIds: ["s2"],
    enabled: false
  });
  assert.deepEqual(core.getSourcePolicy(s1), {
    ok: true,
    mode: "shared",
    sharedSessionIds: ["s2"],
    enabled: false
  }, "the owner API can still read the disabled policy");

  // Another target's preview omits the disabled source immediately.
  const hidden = core.readRecentActivity(s2, { now: T0 + 2 });
  assert.equal(hidden.ok, true);
  assert.equal(hidden.count, 0);

  // The disabled Session's own explicit read is denied. Model-supplied policy
  // fields in read options cannot re-enable it or grant sharing.
  for (const options of [
    { now: T0 + 2, sources: ["s1"] },
    { now: T0 + 2, sources: ["s1"], enabled: true, mode: "shared" }
  ]) {
    const self = core.readRecentActivity(s1, options);
    assert.equal(self.ok, false);
    assert.equal(self.reason, "source-disabled");
    assert.deepEqual(self.items, []);
    assert.equal(self.count, 0);
  }

  // Collection returns before snapshotEvents/transcript access.
  let snapshotReads = 0;
  const disabledEvents = [
    userEvent(4, "must not be collected"),
    assistantEvent(5, "must not be collected answer"),
    turnEnd(6)
  ];
  const disabledSession = {
    id: "s1",
    events: disabledEvents,
    snapshotEvents() {
      snapshotReads += 1;
      return disabledEvents;
    }
  };
  const skipped = core.recordTurnEnd(disabledSession, endOf(disabledEvents, 6), { now: T0 + 3 });
  assert.equal(skipped.ok, false);
  assert.equal(skipped.reason, "source-disabled");
  assert.equal(snapshotReads, 0);
  assert.equal(eventCount(db), 1);

  // Re-enabling restores the still-unexpired event immediately.
  assert.equal(core.setSourcePolicy(s1, {
    mode: "shared",
    sharedSessionIds: ["s2"],
    enabled: true
  }).ok, true);
  assert.equal(core.readRecentActivity(s2, { now: T0 + 4 }).count, 1);
  assert.equal(core.readRecentActivity(s1, { now: T0 + 4, sources: ["s1"] }).count, 1);

  // Disable, let the TTL pass, then re-enable: expiry is not resurrected.
  assert.equal(core.setSourcePolicy(s1, {
    mode: "shared",
    sharedSessionIds: ["s2"],
    enabled: false
  }).ok, true);
  assert.equal(core.readRecentActivity(s2, { now: T0 + HOUR + 1 }).count, 0);
  assert.equal(eventCount(db), 0);
  assert.equal(core.setSourcePolicy(s1, {
    mode: "shared",
    sharedSessionIds: ["s2"],
    enabled: true
  }).ok, true);
  assert.equal(core.readRecentActivity(s2, { now: T0 + HOUR + 2 }).count, 0);
  assert.equal(eventCount(db), 0);
  db.close();
});

test("old policy table upgrades additively, keeps modes/allowlists, and repeated creation is harmless", () => {
  const db = openDatabase(tempDbPath());
  db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL
    );
    INSERT INTO memories VALUES ('m1', 'must stay untouched');
    CREATE TABLE recent_activity_source_policy (
      workspace_id      TEXT NOT NULL,
      source_session_id TEXT NOT NULL,
      mode              TEXT NOT NULL DEFAULT 'self',
      allowlist         TEXT NOT NULL DEFAULT '[]',
      updated_at        INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, source_session_id)
    );
    INSERT INTO recent_activity_source_policy
      (workspace_id, source_session_id, mode, allowlist, updated_at)
    VALUES
      ('ws-a', 's1', 'shared', '["s2"]', 123),
      ('ws-a', 's3', 'owner', '[]', 124);
  `);

  const core = createRecentActivityCore({ db, workspaceId: "ws-a", allowSession: () => true });
  assert.equal(core.status().ok, true);

  const columns = db.prepare("PRAGMA table_info(recent_activity_source_policy)").all();
  const enabledColumns = columns.filter((column) => column.name === "enabled");
  assert.equal(enabledColumns.length, 1);
  assert.equal(enabledColumns[0].notnull, 1);
  assert.equal(String(enabledColumns[0].dflt_value), "1");

  assert.deepEqual(core.getSourcePolicy(hostSession("s1")), {
    ok: true,
    mode: "shared",
    sharedSessionIds: ["s2"],
    enabled: true
  }, "the old shared allowlist was preserved and defaults to enabled");
  assert.deepEqual(core.getSourcePolicy(hostSession("s3")), {
    ok: true,
    mode: "owner",
    sharedSessionIds: [],
    enabled: true
  });
  assert.deepEqual(
    db.prepare("SELECT content FROM memories").all().map((row) => row.content),
    ["must stay untouched"]
  );

  // A second core over the same DB must not duplicate the column or reset rows.
  const second = createRecentActivityCore({ db, workspaceId: "ws-a", allowSession: () => true });
  assert.equal(second.status().ok, true);
  assert.equal(
    db.prepare("PRAGMA table_info(recent_activity_source_policy)").all()
      .filter((column) => column.name === "enabled").length,
    1
  );
  assert.deepEqual(second.getSourcePolicy(hostSession("s1")), {
    ok: true,
    mode: "shared",
    sharedSessionIds: ["s2"],
    enabled: true
  });
  db.close();
});

test("policy cap rejects new rows without evicting old disabled/shared policies; existing rows still update", () => {
  const db = openDatabase(tempDbPath());
  const core = createRecentActivityCore({ db, workspaceId: "ws-a", allowSession: () => true });
  const disabled = hostSession("cap-disabled");
  const shared = hostSession("cap-shared");

  assert.equal(core.setSourcePolicy(disabled, { mode: "self", enabled: false }).ok, true);
  assert.equal(core.setSourcePolicy(shared, {
    mode: "shared",
    sharedSessionIds: ["s2"],
    enabled: true
  }).ok, true);
  for (let index = 0; index < RECENT_ACTIVITY_LIMITS.MAX_POLICY_ROWS - 2; index += 1) {
    assert.equal(core.setSourcePolicy(hostSession(`cap-${index}`), { mode: "self" }).ok, true);
  }
  assert.equal(policyCount(db), RECENT_ACTIVITY_LIMITS.MAX_POLICY_ROWS);

  // A brand-new row is rejected explicitly; no old row is evicted.
  const overflow = core.setSourcePolicy(hostSession("cap-overflow"), {
    mode: "shared",
    sharedSessionIds: ["s3"],
    enabled: false
  });
  assert.deepEqual(overflow, { ok: false, reason: "policy-cap-reached" });
  assert.equal(policyCount(db), RECENT_ACTIVITY_LIMITS.MAX_POLICY_ROWS);
  assert.equal(db.prepare(
    `SELECT 1 AS present FROM recent_activity_source_policy
     WHERE workspace_id = ? AND source_session_id = ?`
  ).get("ws-a", "cap-overflow"), undefined);

  // The oldest restrictions remain intact, including the disabled switch.
  assert.deepEqual(core.getSourcePolicy(disabled), {
    ok: true,
    mode: "self",
    sharedSessionIds: [],
    enabled: false
  });
  assert.deepEqual(core.getSourcePolicy(shared), {
    ok: true,
    mode: "shared",
    sharedSessionIds: ["s2"],
    enabled: true
  });

  // An existing row may still be updated at the cap, and that update preserves
  // the omitted enabled switch.
  assert.deepEqual(core.setSourcePolicy(disabled, { mode: "owner" }), {
    ok: true,
    mode: "owner",
    sharedSessionIds: [],
    enabled: false
  });
  assert.equal(policyCount(db), RECENT_ACTIVITY_LIMITS.MAX_POLICY_ROWS);
  assert.deepEqual(core.setSourcePolicy(disabled, { mode: "self", enabled: true }), {
    ok: true,
    mode: "self",
    sharedSessionIds: [],
    enabled: true
  });
  assert.equal(policyCount(db), RECENT_ACTIVITY_LIMITS.MAX_POLICY_ROWS);
  db.close();
});

test("stats is bounded to this Workspace, returns no raw text or Workspace IDs, and fails safely", () => {
  const db = openDatabase(tempDbPath());
  const coreA = createRecentActivityCore({
    db,
    workspaceId: "ws-a",
    allowSession: () => true,
    config: { ttlHours: 6, maxItems: 4, maxTokens: 500 }
  });
  const coreB = createRecentActivityCore({ db, workspaceId: "ws-b", allowSession: () => true });

  const aEvents = [
    userEvent(1, "secret topic alpha one"),
    assistantEvent(2, "secret answer alpha one"),
    turnEnd(3),
    userEvent(4, "secret topic alpha two"),
    assistantEvent(5, "secret answer alpha two"),
    turnEnd(6)
  ];
  const aSession = hostSession("s1", aEvents);
  assert.equal(coreA.recordTurnEnd(aSession, endOf(aEvents, 3), { now: T0 }).ok, true);
  assert.equal(coreA.recordTurnEnd(aSession, endOf(aEvents, 6), { now: T0 + 10 }).ok, true);

  const a3Events = [
    userEvent(1, "third source topic"),
    assistantEvent(2, "third source answer"),
    turnEnd(3)
  ];
  const a3 = hostSession("s3", a3Events);
  assert.equal(coreA.recordTurnEnd(a3, endOf(a3Events, 3), { now: T0 + 20 }).ok, true);

  const bEvents = [
    userEvent(1, "workspace b secret"),
    assistantEvent(2, "workspace b answer"),
    turnEnd(3)
  ];
  const bSession = hostSession("b1", bEvents);
  assert.equal(coreB.recordTurnEnd(bSession, endOf(bEvents, 3), { now: T0 + 30 }).ok, true);

  assert.equal(coreA.setSourcePolicy(aSession, {
    mode: "shared",
    sharedSessionIds: ["s2"]
  }, { now: T0 + 40 }).ok, true);
  assert.equal(coreA.setSourcePolicy(a3, { mode: "self", enabled: false }, { now: T0 + 50 }).ok, true);
  assert.equal(coreB.setSourcePolicy(bSession, { mode: "self" }, { now: T0 + 60 }).ok, true);

  const stats = coreA.stats();
  assert.equal(stats.ok, true);
  assert.equal(stats.reason, "ok");
  assert.equal(stats.eventCount, 3);
  assert.deepEqual(stats.sourceCounts, [
    { sourceSessionId: "s1", count: 2 },
    { sourceSessionId: "s3", count: 1 }
  ]);
  assert.equal(stats.policyCount, 2);
  assert.ok(stats.summaryBytes > 0);
  assert.equal(stats.lastUpdatedAt, T0 + 50);
  assert.deepEqual(stats.config, coreA.getConfig());
  coreA.configure({ maxItems: 2 });
  assert.equal(coreA.stats().config.maxItems, 2);

  const serialized = JSON.stringify(stats);
  assert.equal(serialized.includes("ws-a"), false);
  assert.equal(serialized.includes("ws-b"), false);
  assert.equal(serialized.includes("secret topic"), false);
  assert.equal(serialized.includes("secret answer"), false);

  const statsB = coreB.stats();
  assert.equal(statsB.ok, true);
  assert.equal(statsB.eventCount, 1);
  assert.deepEqual(statsB.sourceCounts, [{ sourceSessionId: "b1", count: 1 }]);
  assert.equal(statsB.policyCount, 1);
  assert.equal(statsB.lastUpdatedAt, T0 + 60);
  assert.equal(JSON.stringify(statsB).includes("ws-a"), false);

  // Stats mutates nothing: repeated calls leave rows, policies and text intact.
  const before = {
    events: eventCount(db, "ws-a"),
    policies: policyCount(db, "ws-a"),
    summary: db.prepare(
      `SELECT summary FROM recent_activity_events
       WHERE workspace_id = ? AND source_session_id = ?
       ORDER BY occurred_at ASC LIMIT 1`
    ).get("ws-a", "s1").summary
  };
  coreA.stats();
  coreA.stats();
  assert.equal(eventCount(db, "ws-a"), before.events);
  assert.equal(policyCount(db, "ws-a"), before.policies);
  assert.equal(db.prepare(
    `SELECT summary FROM recent_activity_events
     WHERE workspace_id = ? AND source_session_id = ?
     ORDER BY occurred_at ASC LIMIT 1`
  ).get("ws-a", "s1").summary, before.summary);

  const unavailable = createRecentActivityCore({
    db: null,
    workspaceId: "ws-a",
    allowSession: () => true
  });
  const failed = unavailable.stats();
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, "storage-unavailable");
  assert.deepEqual(failed.sourceCounts, []);
  assert.equal(failed.eventCount, 0);
  assert.equal(failed.policyCount, 0);
  assert.deepEqual(failed.config, unavailable.getConfig());

  const emptyCore = createRecentActivityCore({
    db,
    workspaceId: "ws-empty",
    allowSession: () => true
  });
  const emptyStats = emptyCore.stats();
  assert.equal(emptyStats.ok, true);
  assert.equal(emptyStats.eventCount, 0);
  assert.deepEqual(emptyStats.sourceCounts, []);
  assert.equal(emptyStats.summaryBytes, 0);
  assert.equal(emptyStats.policyCount, 0);
  assert.equal(emptyStats.lastUpdatedAt, null);

  db.close();
  const afterClose = coreA.stats();
  assert.equal(afterClose.ok, false);
  assert.equal(afterClose.reason, "stats-failed");
  assert.deepEqual(afterClose.sourceCounts, []);
});

test("10k-event Session requests a bounded suffix and summarizes only the latest completed turn", () => {
  const db = openDatabase(tempDbPath());
  const core = createRecentActivityCore({ db, workspaceId: "ws-a", allowSession: () => true });
  const events = largeSessionEvents();
  const requests = [];
  const session = {
    id: "s1",
    snapshotEvents(fromSeq, toSeq) {
      requests.push([fromSeq, toSeq]);
      return events.slice(fromSeq, toSeq);
    }
  };

  const result = core.recordTurnEnd(session, events[9999], { now: T0 });
  assert.equal(result.ok, true);
  assert.equal(result.turnSeq, 9999);
  assert.equal(requests.length, 1, "one bounded snapshot request per completed turn");
  const [fromSeq, toSeq] = requests[0];
  assert.equal(toSeq, 9999, "the trusted turn/end is the exclusive upper bound");
  assert.equal(
    toSeq - fromSeq,
    RECENT_ACTIVITY_LIMITS.MAX_TURN_EVENT_WINDOW,
    "only a fixed-size suffix is requested"
  );

  const row = rowFor(db, "ws-a", "s1", 9999);
  assert.match(row.summary, /latest completed turn topic/);
  assert.match(row.summary, /latest completed answer/);
  assert.equal(row.summary.includes("stale previous"), false,
    "the known previous turn/end is never merged into the current turn");
  assert.equal(row.summary.includes("ancient"), false);
  assert.equal(row.summary.includes("filler event"), false);
  db.close();
});

test("older Hosts that ignore snapshot bounds and .events-only fallback keep correct bounded selection", () => {
  const db = openDatabase(tempDbPath());
  const core = createRecentActivityCore({ db, workspaceId: "ws-a", allowSession: () => true });

  // Older Host ignores the two arguments and returns its full event array. The
  // core must still filter by seq, cap the window and select the latest turn.
  const ignoringEvents = largeSessionEvents();
  const ranges = [];
  const ignoringSession = {
    id: "s1",
    snapshotEvents(...args) {
      ranges.push(args);
      return ignoringEvents;
    }
  };
  const ignored = core.recordTurnEnd(ignoringSession, ignoringEvents[9999], { now: T0 });
  assert.equal(ignored.ok, true);
  assert.deepEqual(ranges[0], [9743, 9999],
    "the arguments remain bounded even when the Host ignores them");
  const ignoredRow = rowFor(db, "ws-a", "s1", 9999);
  assert.match(ignoredRow.summary, /latest completed turn topic/);
  assert.equal(ignoredRow.summary.includes("stale previous"), false);
  assert.equal(ignoredRow.summary.includes("ancient"), false);

  // Hosts with no snapshotEvents at all fall back to .events with the same
  // seq filtering/capping and current-turn selection.
  const eventsOnlyEvents = largeSessionEvents();
  const eventsOnlySession = { id: "s2", events: eventsOnlyEvents };
  const eventsOnly = core.recordTurnEnd(eventsOnlySession, eventsOnlyEvents[9999], { now: T0 + 1 });
  assert.equal(eventsOnly.ok, true);
  const eventsOnlyRow = rowFor(db, "ws-a", "s2", 9999);
  assert.match(eventsOnlyRow.summary, /latest completed turn topic/);
  assert.equal(eventsOnlyRow.summary.includes("stale previous"), false);
  assert.equal(eventsOnlyRow.summary.includes("ancient"), false);

  // A throwing snapshotEvents also falls back to .events without widening the
  // persisted summary into older turns.
  const throwingEvents = largeSessionEvents();
  const throwingSession = {
    id: "s3",
    events: throwingEvents,
    snapshotEvents() { throw new Error("deprecated host access failed"); }
  };
  const thrown = core.recordTurnEnd(throwingSession, throwingEvents[9999], { now: T0 + 2 });
  assert.equal(thrown.ok, true);
  const thrownRow = rowFor(db, "ws-a", "s3", 9999);
  assert.match(thrownRow.summary, /latest completed turn topic/);
  assert.equal(thrownRow.summary.includes("stale previous"), false);
  db.close();
});

test("a turn longer than the bounded window degrades conservatively without claiming success", () => {
  const db = openDatabase(tempDbPath());
  const core = createRecentActivityCore({ db, workspaceId: "ws-a", allowSession: () => true });
  const events = Array.from({ length: 1002 }, (_, seq) => ({
    seq,
    type: "plan/update",
    data: { text: `long-turn filler ${seq}` }
  }));
  events[0] = userEvent(0, "previous turn topic");
  events[1] = assistantEvent(1, "previous turn answer");
  events[2] = turnEnd(2);
  events[3] = userEvent(3, "long turn initial topic outside the window");
  events[10] = toolCall(10);
  events[11] = toolResult(11, true);
  events[900] = toolCall(900);
  events[901] = toolResult(901, false);
  events[1000] = assistantEvent(1000, "long turn final answer");
  events[1001] = turnEnd(1001);

  const requests = [];
  const session = {
    id: "s1",
    snapshotEvents(fromSeq, toSeq) {
      requests.push([fromSeq, toSeq]);
      return events.slice(fromSeq, toSeq);
    }
  };
  const result = core.recordTurnEnd(session, events[1001], { now: T0 });
  assert.equal(result.ok, true);
  assert.equal(result.kind, "conversation",
    "a partial window never asserts unverified tool success");
  assert.deepEqual(requests[0], [745, 1001]);
  assert.equal(requests[0][1] - requests[0][0], RECENT_ACTIVITY_LIMITS.MAX_TURN_EVENT_WINDOW);

  const row = rowFor(db, "ws-a", "s1", 1001);
  assert.match(row.summary, /long turn final answer/);
  assert.match(row.summary, /Scope: partial turn window/);
  assert.equal(row.summary.includes("long turn initial topic outside the window"), false);
  assert.equal(row.summary.includes("previous turn"), false);
  assert.equal(row.summary.includes("Tool evidence"), false);
  assert.equal(row.kind, "conversation");
  db.close();
});
