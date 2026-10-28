// Owner-only recent-activity management API. Synthetic Registry/Session IDs,
// a temporary control root and an isolated SQLite store only.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSettings } from "../src/settings.js";
import { mountAdminApi } from "../src/admin-api.js";
import { createRecentActivityCore } from "../src/recent-activity.js";
import { createRecentActivityRuntime } from "../src/index.js";
import { createInjector } from "../src/inject.js";
import { createWorkspaceAccessGuard } from "../src/workspace-binding.js";

const BASE = "/api/amadeus-memory/admin";
const T0 = 1_700_000_000_000;
const tempDirs = [];

test.after(() => {
  for (const dir of tempDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "mneme-admin-recent-"));
  tempDirs.push(dir);
  return dir;
}

function baseWorkspaces() {
  return [
    { id: "ws-a", title: "Alpha", sessionIds: ["s1", "s2", "s3"] },
    { id: "ws-b", title: "Beta", sessionIds: ["b1"] }
  ];
}

function writeBinding(dir, workspaceId) {
  writeFileSync(
    join(dir, "workspace-binding.json"),
    `${JSON.stringify({ version: 1, workspaceId }, null, 2)}\n`,
    "utf8"
  );
}

function setup({
  activeWorkspaceId = "ws-a",
  bootEnabled = true,
  owner = true,
  workspaces = baseWorkspaces(),
  bindingWorkspaceId = "ws-a",
  sessionItems = [
    { sessionId: "s1", updatedAt: T0 - 3000 },
    { sessionId: "s2", updatedAt: T0 - 1000 },
    { sessionId: "s3", updatedAt: T0 - 2000 },
    { sessionId: "b1", updatedAt: T0 - 500 },
    { sessionId: "outsider", updatedAt: T0 }
  ]
} = {}) {
  const dir = tempDir();
  if (bindingWorkspaceId !== null) writeBinding(dir, bindingWorkspaceId);
  const state = { workspaces, sessionItems, owner, malformed: false };
  const routes = [];
  const ctx = {
    workspaceRegistry: {
      list() {
        return state.malformed ? "not-a-list" : state.workspaces;
      }
    },
    sessionController: {
      async list() {
        return { items: state.sessionItems };
      }
    },
    logger: { warn() {}, info() {} },
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      }
    },
    connection: {
      admit(req) {
        if (req.headers?.["x-test-unauthenticated"] === "1") return { rejection: 401 };
        return { peer: { principal: { kind: state.owner ? "owner" : "guest" } } };
      }
    },
    inject(_names, apply) { apply(ctx); },
    effect(fn) { return fn(); }
  };

  const store = createStore(":memory:");
  const settings = createSettings(store.db);
  const config = { language: "zh", autoInject: true, recentActivityEnabled: bootEnabled, coreMemoryEnabled: false };
  const service = createService({ store, mirror: null, config });
  const guard = createWorkspaceAccessGuard({ memoryDir: dir, activeWorkspaceId, ctx });

  let runtime = null;
  let core = null;
  let adminCore = null;
  if (bootEnabled && activeWorkspaceId) {
    const persisted = settings.getRecentActivityConfig();
    const coreConfig = {
      ttlHours: persisted.ttl_hours,
      maxItems: persisted.max_items,
      maxTokens: persisted.max_tokens
    };
    runtime = createRecentActivityRuntime({
      ctx: { on() { return () => {}; } },
      db: store.db,
      workspaceId: activeWorkspaceId,
      authorizeModelWork: guard.authorize,
      isEnabled: () => settings.getFeatureFlags().recentActivityEnabled !== false,
      isTrustedOwner: () => false,
      config: coreConfig,
      now: () => T0
    });
    core = runtime.core;
    adminCore = createRecentActivityCore({
      db: store.db,
      workspaceId: activeWorkspaceId,
      allowSession: guard.authorize,
      isTrustedOwner: () => false,
      config: coreConfig,
      now: () => T0
    });
    if (adminCore.status?.().ok !== true) adminCore = null;
  }

  mountAdminApi(ctx, {
    service,
    settings,
    store,
    config,
    controlRoot: dir,
    activeWorkspaceId,
    recentActivity: core,
    recentActivityAdmin: adminCore,
    recentActivityBootEnabled: bootEnabled
  });
  assert.equal(routes.length, 1);

  return {
    dir,
    ctx,
    state,
    store,
    settings,
    service,
    guard,
    route: routes[0],
    runtime,
    core,
    adminCore,
    close() { try { store.close(); } catch { /* already closed */ } }
  };
}

function makeRes() {
  return {
    status: 0,
    body: "",
    headers: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = String(body ?? ""); }
  };
}

function req({ method = "GET", url = "/", headers = {}, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    method,
    url,
    headers: { host: "127.0.0.1:5119", origin: "http://127.0.0.1:5119", ...headers },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; }
  };
}

async function call(h, options = {}) {
  const res = makeRes();
  await h.route.handler(req(options), res);
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* non-JSON */ }
  return { status: res.status, json, body: res.body };
}

function post(h, path, body, headers = {}) {
  return call(h, {
    method: "POST",
    url: `${BASE}${path}`,
    headers: { "content-type": "application/json", "x-amadeus-memory": "1", ...headers },
    body
  });
}

function userMessage(seq, text) {
  return {
    seq,
    type: "user/message",
    data: { source: { kind: "user" }, content: [{ type: "text", text }] }
  };
}

function assistantMessage(seq, text) {
  return {
    seq,
    type: "assistant/message",
    data: { message: { role: "assistant", content: [{ type: "text", text }] } }
  };
}

function turnEnd(seq) {
  return { seq, type: "turn/end", data: {} };
}

function turnBlock(startSeq, topic, reply = `${topic} assistant reply`) {
  return [
    userMessage(startSeq, `${topic} user request`),
    assistantMessage(startSeq + 1, reply),
    turnEnd(startSeq + 2)
  ];
}

function hostSession(id, events = []) {
  return {
    id,
    events,
    snapshotEvents(fromSeq = 0, toSeqExclusive = Infinity) {
      return this.events.filter((event) => event.seq >= fromSeq && event.seq < toSeqExclusive);
    }
  };
}

function recordTurn(h, id, startSeq, topic, reply) {
  const session = hostSession(id, turnBlock(startSeq, topic, reply));
  h.runtime.onSessionEvent(session, turnEnd(startSeq + 2));
  return session;
}

function eventCount(h, workspaceId = "ws-a") {
  try {
    return Number(h.store.db.prepare(
      "SELECT COUNT(*) AS count FROM recent_activity_events WHERE workspace_id = ?"
    ).get(workspaceId)?.count ?? 0);
  } catch {
    return 0;
  }
}

function policyRowCount(h, workspaceId = "ws-a") {
  try {
    return Number(h.store.db.prepare(
      "SELECT COUNT(*) AS count FROM recent_activity_source_policy WHERE workspace_id = ?"
    ).get(workspaceId)?.count ?? 0);
  } catch {
    return 0;
  }
}

function sessionDto(state, id) {
  return state.sessions.find((session) => session.id === id);
}

test("admin recent: owner auth and a dynamically listed strict Session set", async () => {
  const h = setup();
  try {
    assert.equal((await call(h, {
      url: `${BASE}/recent`,
      headers: { "x-test-unauthenticated": "1" }
    })).status, 401);

    assert.equal((await call(h, {
      method: "POST",
      url: `${BASE}/recent/config`,
      headers: { "content-type": "application/json" },
      body: { ttl_hours: 1 }
    })).status, 403, "the Amadeus Memory request marker is still required");

    assert.equal((await call(h, {
      url: `${BASE}/recent/preview?target_session_id=s1`,
      headers: { origin: "http://cross-site.example" }
    })).status, 403, "cross-origin requests are rejected");

    const guest = setup({ owner: false });
    try {
      assert.equal((await call(guest, { url: `${BASE}/recent` })).status, 403);
    } finally {
      guest.close();
    }

    const res = await call(h, { url: `${BASE}/recent` });
    assert.equal(res.status, 200);
    const data = res.json.data;
    assert.equal(data.active_workspace_id, "ws-a");
    assert.equal(data.selected_workspace_id, "ws-a");
    assert.equal(data.runtime_mode, "selected");
    assert.equal(data.enabled, true);
    assert.equal(data.configured_enabled, true);
    assert.equal(data.pending_restart, false);
    assert.deepEqual(data.config, {
      ttl_hours: 24, auto_inject: true, max_items: 3, max_tokens: 300
    });
    assert.equal(data.sessions_available, true);
    assert.equal(data.last_activity_available, true);
    assert.equal(data.stats.event_count, 0);
    assert.equal(data.stats.last_updated, null);
    assert.deepEqual(data.sessions.map((session) => session.id), ["s2", "s3", "s1"]);
    assert.equal(data.sessions.every((session) => session.title === null), true);
    assert.equal(sessionDto(data, "s2").last_active_at, T0 - 1000);
    assert.equal(sessionDto(data, "s1").enabled, true);
    assert.equal(sessionDto(data, "s1").mode, "self");
    assert.deepEqual(sessionDto(data, "s1").shared_session_ids, []);
    assert.equal(JSON.stringify(data).includes("b1"), false, "another Workspace is never listed");
    assert.equal(JSON.stringify(data).includes("outsider"), false, "controller-only IDs never become sessions");
    assert.equal(res.body.includes(h.dir), false, "no local path is exposed");
    // The obsolete Recent card's fields remain for existing clients.
    assert.equal(typeof data.ttl_ms, "number");
    assert.equal(Array.isArray(data.scenes), true);
    assert.equal(data.total_events, 0);
  } finally {
    h.close();
  }
});

test("admin recent: async Host list supplies bounded display titles for Registry IDs only", async () => {
  const longTitle = "T".repeat(250);
  const h = setup({
    sessionItems: [
      { sessionId: "s1", updatedAt: T0 - 100, projections: { values: { title: "  Release   planning  " } } },
      { sessionId: "s2", updatedAt: T0 - 200, projections: { values: { title: `${longTitle}\u0000\u202E` } } },
      { sessionId: "s3", updatedAt: T0 - 300 },
      { sessionId: "b1", updatedAt: T0, projections: { values: { title: "other workspace" } } },
      { sessionId: "outsider", updatedAt: T0, projections: { values: { title: "controller only" } } }
    ]
  });
  try {
    const res = await call(h, { url: `${BASE}/recent` });
    assert.equal(res.status, 200);
    const data = res.json.data;
    assert.equal(data.last_activity_available, true);
    assert.deepEqual(data.sessions.map((session) => session.id), ["s1", "s2", "s3"]);
    assert.equal(sessionDto(data, "s1").title, "Release planning");
    assert.equal(sessionDto(data, "s1").last_active_at, T0 - 100);
    assert.equal(sessionDto(data, "s2").title, "T".repeat(200));
    assert.equal(sessionDto(data, "s2").last_active_at, T0 - 200);
    assert.equal(sessionDto(data, "s3").title, null, "a missing title projection leaves the ID fallback");
    assert.equal(sessionDto(data, "s3").last_active_at, T0 - 300);
    assert.equal(JSON.stringify(data).includes("other workspace"), false);
    assert.equal(JSON.stringify(data).includes("controller only"), false);
    assert.doesNotMatch(res.body, /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/,
      "control characters never reach the display title");
  } finally {
    h.close();
  }
});

test("admin recent: invalid Host timestamps never become last_active_at", async () => {
  const h = setup({
    sessionItems: [
      { sessionId: "s1", updatedAt: -1 },
      { sessionId: "s2", updatedAt: Number.NaN },
      { sessionId: "s3", updatedAt: String(T0) },
      { sessionId: "b1", updatedAt: T0 }
    ]
  });
  try {
    const res = await call(h, { url: `${BASE}/recent` });
    assert.equal(res.status, 200);
    const data = res.json.data;
    assert.equal(data.last_activity_available, true);
    assert.deepEqual(data.sessions.map((session) => session.id), ["s1", "s2", "s3"]);
    assert.equal(data.sessions.every((session) => session.last_active_at === null), true);
    assert.equal(data.sessions.every((session) => session.title === null), true);
  } finally {
    h.close();
  }
});

test("admin recent: missing or rejecting Host metadata degrades safely", async () => {
  const h = setup();
  try {
    h.ctx.sessionController.list = async () => { throw new Error("host session list unavailable"); };
    let res = await call(h, { url: `${BASE}/recent` });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.sessions_available, true);
    assert.equal(res.json.data.last_activity_available, false);
    assert.equal(res.json.data.sessions.length, 3);
    assert.equal(res.json.data.sessions.every((session) => session.last_active_at === null), true);
    assert.equal(res.json.data.sessions.every((session) => session.title === null), true);

    delete h.ctx.sessionController;
    res = await call(h, { url: `${BASE}/recent` });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.sessions_available, true);
    assert.equal(res.json.data.last_activity_available, false);
    assert.equal(res.json.data.sessions.length, 3);

    h.ctx.sessionController = { list: async () => ({ items: "not-an-array" }) };
    res = await call(h, { url: `${BASE}/recent` });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.last_activity_available, false);
    assert.equal(res.json.data.sessions.length, 3);
  } finally {
    h.close();
  }
});

test("admin recent: unbound mode is safe status only and every mutation rejects", async () => {
  const h = setup({ activeWorkspaceId: null, bootEnabled: false, bindingWorkspaceId: null });
  try {
    const status = await call(h, { url: `${BASE}/recent` });
    assert.equal(status.status, 200);
    assert.equal(status.json.data.runtime_mode, "unbound");
    assert.equal(status.json.data.active_workspace_id, null);
    assert.deepEqual(status.json.data.sessions, []);
    assert.equal(status.json.data.enabled, false);
    assert.equal(status.json.data.stats.event_count, 0);
    assert.deepEqual(status.json.data.config, {
      ttl_hours: 24, auto_inject: true, max_items: 3, max_tokens: 300
    });

    const config = await post(h, "/recent/config", { ttl_hours: 6 });
    assert.equal(config.status, 409);
    assert.equal(config.json.reason, "no-active-workspace");
    const policy = await post(h, "/recent/policy", {
      source_session_id: "s1", enabled: true, mode: "self"
    });
    assert.equal(policy.status, 409);
    const preview = await call(h, {
      url: `${BASE}/recent/preview?target_session_id=s1`
    });
    assert.equal(preview.status, 409);
    assert.equal(policyRowCount(h), 0);
  } finally {
    h.close();
  }
});

test("admin recent: malformed/ambiguous Registry fails closed and moved IDs are rejected", async () => {
  const h = setup();
  try {
    h.state.malformed = true;
    const malformed = await call(h, { url: `${BASE}/recent` });
    assert.equal(malformed.status, 200);
    assert.deepEqual(malformed.json.data.sessions, []);
    assert.equal(malformed.json.data.sessions_available, false);
    assert.equal(malformed.json.data.sessions_error, "malformed-registry");
    assert.equal(malformed.body.includes("s1"), false);
    const blockedPolicy = await post(h, "/recent/policy", {
      source_session_id: "s1", enabled: true, mode: "self"
    });
    assert.equal(blockedPolicy.status, 409);
    assert.equal(policyRowCount(h), 0);

    h.state.malformed = false;
    const unknown = await post(h, "/recent/policy", {
      source_session_id: "unknown-session", enabled: true, mode: "self"
    });
    assert.equal(unknown.status, 400);
    assert.equal(unknown.json.reason, "unknown-session-id");
    assert.equal(policyRowCount(h), 0);

    h.state.workspaces = [
      { id: "ws-a", title: "Alpha", sessionIds: ["s1", "s2"] },
      { id: "ws-a", title: "Alpha duplicate", sessionIds: ["s3"] }
    ];
    const ambiguous = await call(h, { url: `${BASE}/recent` });
    assert.equal(ambiguous.status, 200);
    assert.deepEqual(ambiguous.json.data.sessions, []);
    assert.equal(ambiguous.json.data.sessions_error, "ambiguous-registry");

    h.state.workspaces = baseWorkspaces();
    h.state.workspaces[0].sessionIds = ["s1", "s3"];
    h.state.workspaces[1].sessionIds = ["b1", "s2"];
    const movedTarget = await post(h, "/recent/policy", {
      source_session_id: "s1", enabled: true, mode: "shared", shared_session_ids: ["s2"]
    });
    assert.equal(movedTarget.status, 400);
    assert.equal(movedTarget.json.reason, "unknown-session-id");
    assert.equal(policyRowCount(h), 0);
    const movedSource = await post(h, "/recent/policy", {
      source_session_id: "s2", enabled: true, mode: "self"
    });
    assert.equal(movedSource.status, 400);
    assert.equal((await call(h, {
      url: `${BASE}/recent/preview?target_session_id=s2`
    })).status, 400, "a moved Session is not a valid preview target");
  } finally {
    h.close();
  }
});

test("admin recent: policy save/revoke drives the server-filtered preview and the model core", async () => {
  const h = setup();
  try {
    recordTurn(h, "s1", 1, "Alpha topic", "Alpha reply");
    assert.equal(eventCount(h), 1);

    const saved = await post(h, "/recent/policy", {
      source_session_id: "s1",
      enabled: true,
      mode: "shared",
      shared_session_ids: ["s2"]
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.json.data.mode, "shared");
    assert.deepEqual(saved.json.data.shared_session_ids, ["s2"]);
    assert.equal(saved.json.data.state.sessions.find((s) => s.id === "s1").mode, "shared");

    const listed = await call(h, { url: `${BASE}/recent` });
    const s1 = listed.json.data.sessions.find((session) => session.id === "s1");
    assert.equal(s1.mode, "shared");
    assert.deepEqual(s1.shared_session_ids, ["s2"]);

    const preview = await call(h, {
      url: `${BASE}/recent/preview?target_session_id=s2`
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.json.ok, true);
    assert.equal(preview.json.data.ok, true);
    assert.equal(preview.json.data.count, 1);
    assert.equal(preview.json.data.items[0].sourceSessionId, "s1");
    assert.match(preview.json.data.items[0].summary, /Alpha topic/);
    assert.deepEqual(Object.keys(preview.json.data).sort(),
      ["count", "estimatedTokens", "items", "ok", "reason", "truncated"]);
    assert.deepEqual(Object.keys(preview.json.data.items[0]).sort(),
      ["estimatedTokens", "kind", "occurredAt", "sourceSessionId", "summary"]);

    const modelView = h.core.readRecentActivity({ id: "s2" }, { includeSelf: false });
    assert.equal(modelView.ok, true);
    assert.equal(modelView.count, preview.json.data.count);
    assert.equal(modelView.items[0].summary, preview.json.data.items[0].summary);

    assert.equal((await call(h, {
      url: `${BASE}/recent/preview?target_session_id=s3`
    })).json.data.count, 0);

    const ownHidden = await call(h, {
      url: `${BASE}/recent/preview?target_session_id=s1`
    });
    assert.equal(ownHidden.json.data.count, 0, "includeSelf defaults to false");
    const ownVisible = await call(h, {
      url: `${BASE}/recent/preview?target_session_id=s1&include_self=true`
    });
    assert.equal(ownVisible.json.data.count, 1);

    const revoked = await post(h, "/recent/policy", {
      source_session_id: "s1", enabled: true, mode: "self"
    });
    assert.equal(revoked.status, 200);
    assert.deepEqual(revoked.json.data.shared_session_ids, []);
    assert.equal((await call(h, {
      url: `${BASE}/recent/preview?target_session_id=s2`
    })).json.data.count, 0);
  } finally {
    h.close();
  }
});

test("admin recent: per-source enabled revokes collection/read and never resurrects old events", async () => {
  const h = setup();
  try {
    const disabled = await post(h, "/recent/policy", {
      source_session_id: "s1", enabled: false, mode: "self"
    });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.json.data.enabled, false);
    assert.equal(disabled.json.data.state.sessions.find((s) => s.id === "s1").enabled, false);

    recordTurn(h, "s1", 1, "must not be collected");
    assert.equal(eventCount(h), 0, "disabled source skips collection before the transcript");

    const denied = await call(h, {
      url: `${BASE}/recent/preview?target_session_id=s1&include_self=true`
    });
    assert.equal(denied.status, 200);
    assert.equal(denied.json.data.ok, false);
    assert.equal(denied.json.data.reason, "source-disabled");
    assert.deepEqual(denied.json.data.items, []);

    assert.equal((await post(h, "/recent/policy", {
      source_session_id: "s1", enabled: true, mode: "self"
    })).status, 200);
    assert.equal((await call(h, {
      url: `${BASE}/recent/preview?target_session_id=s1&include_self=true`
    })).json.data.count, 0, "re-enabling does not resurrect a never-recorded turn");

    recordTurn(h, "s1", 4, "after re-enable");
    assert.equal(eventCount(h), 1);
    assert.equal((await call(h, {
      url: `${BASE}/recent/preview?target_session_id=s1&include_self=true`
    })).json.data.count, 1);
  } finally {
    h.close();
  }
});

test("admin recent: config is validated atomically, persisted, and auto-inject is live", async () => {
  const h = setup();
  try {
    const initial = await call(h, { url: `${BASE}/recent` });
    assert.deepEqual(initial.json.data.config, {
      ttl_hours: 24, auto_inject: true, max_items: 3, max_tokens: 300
    });

    for (const body of [
      { ttl_hours: 12 },
      { max_items: 0 },
      { max_items: 11 },
      { max_tokens: 99 },
      { max_tokens: 801 },
      { auto_inject: "yes" },
      { unknown_setting: true }
    ]) {
      assert.equal((await post(h, "/recent/config", body)).status, 400, JSON.stringify(body));
    }
    assert.deepEqual(h.settings.getRecentActivityConfig(), {
      ttl_hours: 24, auto_inject: true, max_items: 3, max_tokens: 300
    });

    const mixed = await post(h, "/recent/config", { ttl_hours: 6, max_items: 99 });
    assert.equal(mixed.status, 400);
    assert.equal(h.settings.getRecentActivityConfig().ttl_hours, 24, "mixed patch is atomic");

    const originalSetFeatureFlags = h.settings.setFeatureFlags;
    h.settings.setFeatureFlags = () => { throw new Error("simulated second write failure"); };
    try {
      const failed = await post(h, "/recent/config", { ttl_hours: 72, enabled: false });
      assert.equal(failed.status, 400);
      assert.equal(h.settings.getRecentActivityConfig().ttl_hours, 24,
        "a failed feature-flag write must roll back the earlier config write");
    } finally {
      h.settings.setFeatureFlags = originalSetFeatureFlags;
    }

    const saved = await post(h, "/recent/config", {
      ttl_hours: 6,
      auto_inject: false,
      max_items: 5,
      max_tokens: 500,
      enabled: true
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.json.data.config, {
      ttl_hours: 6, auto_inject: false, max_items: 5, max_tokens: 500
    });
    assert.deepEqual(h.settings.getRecentActivityConfig(), saved.json.data.config);
    assert.deepEqual(h.core.getConfig(), { ttlHours: 6, maxItems: 5, maxTokens: 500 });
    assert.equal(saved.json.data.enabled, true);
    assert.equal(saved.json.data.pending_restart, false);

    recordTurn(h, "s1", 1, "auto inject topic");
    assert.equal((await post(h, "/recent/policy", {
      source_session_id: "s1", enabled: true, mode: "shared", shared_session_ids: ["s2"]
    })).status, 200);

    const render = () => {
      const contexts = {};
      const promptCtx = {
        logger: { warn() {} },
        systemPrompt: {
          context(spec) { contexts[spec.name] = spec.text; return () => {}; },
          section() { return () => {}; }
        }
      };
      const service = {
        injectCandidates: () => [],
        embedQuery: async () => null,
        hasSceneScopedRows: () => false
      };
      const dispose = createInjector(
        promptCtx,
        service,
        h.settings,
        {
          hotMemoryEnabled: false,
          maxInjectedItems: 5,
          importanceThreshold: 3,
          injectRotationTurns: 0,
          recentActivityEnabled: true
        },
        null,
        h.guard.authorize,
        h.core,
        () => h.settings.getRecentActivityConfig()
      );
      return {
        block: contexts["recent-activity"]?.({ agent: { session: hostSession("s2") } }) ?? "",
        dispose
      };
    };

    const disabledAuto = render();
    try {
      assert.equal(disabledAuto.block, "", "auto_inject=false suppresses the next prompt");
    } finally {
      disabledAuto.dispose();
    }

    assert.equal((await post(h, "/recent/config", { auto_inject: true })).status, 200);
    const enabledAuto = render();
    try {
      assert.match(enabledAuto.block, /Past workspace activity/);
      assert.match(enabledAuto.block, /auto inject topic/);
    } finally {
      enabledAuto.dispose();
    }
  } finally {
    h.close();
  }
});

test("admin recent: global disable is immediate, re-enable needs no restart when mounted", async () => {
  const h = setup();
  try {
    recordTurn(h, "s1", 1, "collected before disable");
    assert.equal((await post(h, "/recent/policy", {
      source_session_id: "s1", enabled: true, mode: "shared", shared_session_ids: ["s2"]
    })).status, 200);
    assert.equal(h.core.readRecentActivity({ id: "s2" }, { includeSelf: false }).count, 1);

    const disabled = await post(h, "/recent/config", { enabled: false });
    assert.equal(disabled.status, 200);
    assert.equal(disabled.json.data.enabled, false);
    assert.equal(disabled.json.data.configured_enabled, false);
    assert.equal(disabled.json.data.pending_restart, false, "disabling is effective immediately");
    assert.equal(h.core.readRecentActivity({ id: "s2" }, { includeSelf: false }).ok, false);
    assert.equal(
      h.core.readRecentActivity({ id: "s2" }, { includeSelf: false }).reason,
      "recent-activity-disabled"
    );

    recordTurn(h, "s1", 4, "must not be collected while disabled");
    assert.equal(eventCount(h), 1, "the next event is denied immediately");

    const preview = await call(h, {
      url: `${BASE}/recent/preview?target_session_id=s2`
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.json.data.ok, false);
    assert.equal(preview.json.data.reason, "recent-activity-disabled");
    assert.deepEqual(preview.json.data.items, []);

    const listed = await call(h, { url: `${BASE}/recent` });
    assert.equal(listed.json.data.enabled, false);
    assert.equal(listed.json.data.configured_enabled, false);
    assert.equal(listed.json.data.pending_restart, false);

    const enabled = await post(h, "/recent/config", { enabled: true });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.json.data.enabled, true);
    assert.equal(enabled.json.data.pending_restart, false);
    assert.equal(h.core.readRecentActivity({ id: "s2" }, { includeSelf: false }).count, 1);
  } finally {
    h.close();
  }
});

test("admin recent: enabling a boot-disabled runtime is persisted and reports pending restart", async () => {
  const h = setup({ bootEnabled: false });
  try {
    const before = await call(h, { url: `${BASE}/recent` });
    assert.equal(before.json.data.enabled, false);
    assert.equal(before.json.data.configured_enabled, false);
    assert.equal(before.json.data.sessions_available, true);
    assert.equal(before.json.data.sessions.length, 3);

    const enabled = await post(h, "/recent/config", { enabled: true, ttl_hours: 1 });
    assert.equal(enabled.status, 200);
    assert.equal(enabled.json.data.enabled, false);
    assert.equal(enabled.json.data.configured_enabled, true);
    assert.equal(enabled.json.data.pending_restart, true);
    assert.equal(enabled.json.data.config.ttl_hours, 1);
    assert.equal(h.settings.getFeatureFlags().recentActivityEnabled, true);

    const again = await call(h, { url: `${BASE}/recent` });
    assert.equal(again.json.data.pending_restart, true);
    assert.equal(again.json.data.configured_enabled, true);

    const policy = await post(h, "/recent/policy", {
      source_session_id: "s1", enabled: true, mode: "self"
    });
    assert.equal(policy.status, 409);
    assert.equal(policy.json.reason, "recent-activity-unavailable");
  } finally {
    h.close();
  }
});

test("admin recent: a pending binding switch exposes no other Workspace data and blocks mutation", async () => {
  const h = setup();
  try {
    recordTurn(h, "s1", 1, "active store only");
    writeBinding(h.dir, "ws-b");

    const listed = await call(h, { url: `${BASE}/recent` });
    assert.equal(listed.status, 200);
    assert.equal(listed.json.data.active_workspace_id, "ws-a");
    assert.equal(listed.json.data.selected_workspace_id, "ws-b");
    assert.equal(listed.json.data.binding_pending_remount, true);
    assert.equal(listed.json.data.pending_restart, true);
    assert.deepEqual(listed.json.data.sessions.map((session) => session.id), ["s2", "s3", "s1"]);
    assert.equal(JSON.stringify(listed.json.data).includes("b1"), false);

    for (const result of [
      await post(h, "/recent/config", { ttl_hours: 1 }),
      await post(h, "/recent/policy", { source_session_id: "s1", enabled: true, mode: "self" }),
      await call(h, { url: `${BASE}/recent/preview?target_session_id=s1` })
    ]) {
      assert.equal(result.status, 409);
      assert.equal(result.json.reason, "binding-pending-remount");
    }
    assert.equal(eventCount(h), 1);
    assert.equal(policyRowCount(h), 0);
  } finally {
    h.close();
  }
});

test("admin recent: stats are Workspace-scoped, bounded and free of raw transcript/path data", async () => {
  const h = setup();
  try {
    const longReply = "y".repeat(300) + " SECRET_FULL_REPLY " + "z".repeat(300);
    recordTurn(h, "s1", 1, "first topic", "first reply");
    recordTurn(h, "s1", 4, "second topic", longReply);
    recordTurn(h, "s2", 1, "other topic", "other reply");
    assert.equal(eventCount(h), 3);
    assert.equal((await post(h, "/recent/policy", {
      source_session_id: "s1", enabled: true, mode: "shared", shared_session_ids: ["s2"]
    })).status, 200);

    const res = await call(h, { url: `${BASE}/recent` });
    assert.equal(res.status, 200);
    const stats = res.json.data.stats;
    assert.equal(stats.available, true);
    assert.equal(stats.event_count, 3);
    assert.deepEqual(stats.source_counts, [
      { source_session_id: "s1", count: 2 },
      { source_session_id: "s2", count: 1 }
    ]);
    assert.equal(stats.last_updated, T0);
    assert.ok(stats.summary_bytes > 0);
    assert.equal(stats.policy_count, 1);
    assert.deepEqual(stats.config, {
      ttl_hours: 24, auto_inject: true, max_items: 3, max_tokens: 300
    });
    assert.equal(res.body.includes("SECRET_FULL_REPLY"), false, "status never returns summaries");
    assert.equal(res.body.includes("snapshotEvents"), false);
    assert.equal(res.body.includes(h.dir), false);

    const preview = await call(h, {
      url: `${BASE}/recent/preview?target_session_id=s2`
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.includes("SECRET_FULL_REPLY"), false, "only the bounded snippet is returned");
    assert.equal(preview.body.includes("role"), false);
    assert.equal(preview.body.includes("content"), false);
    assert.equal(preview.body.includes("event"), false);
    assert.equal(preview.body.includes(h.dir), false);
  } finally {
    h.close();
  }
});

test("settings recent config: corrupt reads degrade and invalid writes leave the prior value", () => {
  const store = createStore(":memory:");
  try {
    const settings = createSettings(store.db);
    assert.deepEqual(settings.getRecentActivityConfig(), {
      ttl_hours: 24, auto_inject: true, max_items: 3, max_tokens: 300
    });
    settings.setRecentActivityConfig({ ttl_hours: 72, auto_inject: false, max_items: 10, max_tokens: 800 });
    assert.deepEqual(settings.getRecentActivityConfig(), {
      ttl_hours: 72, auto_inject: false, max_items: 10, max_tokens: 800
    });
    assert.throws(() => settings.setRecentActivityConfig({ ttl_hours: 6, max_items: 11 }), /max_items/);
    assert.deepEqual(settings.getRecentActivityConfig(), {
      ttl_hours: 72, auto_inject: false, max_items: 10, max_tokens: 800
    });

    store.db.prepare(
      "INSERT INTO user_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run("recent_activity", "{not-json");
    assert.deepEqual(settings.getRecentActivityConfig(), {
      ttl_hours: 24, auto_inject: true, max_items: 3, max_tokens: 300
    });
  } finally {
    store.close();
  }
});
