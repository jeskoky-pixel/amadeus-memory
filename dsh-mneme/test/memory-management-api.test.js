// Owner-authenticated ordinary-user management and backup endpoints. All data is
// synthetic and lives under an explicit package-local isolated memoryDir.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSettings } from "../src/settings.js";
import { mountAdminApi } from "../src/admin-api.js";
import { applyStagedRestore } from "../src/backup.js";
import { assertIsolatedMemoryDir } from "../src/qa-guard.js";
import { configureRecentContext, recordTrustedRecentEvent, resetRecentContextForTests } from "../src/recent-context.js";
import { mintTrustedScene } from "../src/scene.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", ".test-tmp");
mkdirSync(ROOT, { recursive: true });
let seq = 0;

function setup({ coreMemoryEnabled = true } = {}) {
  const lexical = join(ROOT, `management-${process.pid}-${Date.now()}-${seq++}`);
  const dir = assertIsolatedMemoryDir(lexical, { qaRoot: ROOT });
  const store = createStore(join(dir, "memory.db"));
  const config = {
    language: "zh", autoInject: true, autoSummarize: true, autoDream: false,
    sleepModeEnabled: false, entityExtractionEnabled: false, memoryPreferenceEnabled: false,
    trustedIntakeEnabled: false, rerankEnabled: false, embedProvider: "openai",
    memoryQualityFilter: { enabled: true }, llmAudit: { enabled: true },
    coreMemoryEnabled
  };
  const service = createService({ store, mirror: null, config });
  const settings = createSettings(store.db);
  const routes = [];
  const ctx = {
    webServer: { register(route) { routes.push(route); return () => {}; } },
    connection: { admit() { return { peer: { principal: { kind: "owner" } } }; } },
    inject(_names, apply) { apply(ctx); },
    effect(fn) { return fn(); }
  };
  mountAdminApi(ctx, { service, settings, store, config, memoryDir: dir, embedder: null, vectorIndex: null, reranker: null });
  return {
    dir, store, service, route: routes[0],
    close() { try { store.close(); } catch { /* already closed */ } },
    cleanup() { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  };
}

function makeRes() {
  return {
    status: 0, body: "", headers: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = String(body ?? ""); }
  };
}
function req({ method = "GET", url = "/", body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    method, url,
    headers: { host: "127.0.0.1:5119", origin: "http://127.0.0.1:5119", "content-type": "application/json", "x-amadeus-memory": "1" },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk; }
  };
}
async function call(route, options) {
  const res = makeRes();
  await route.handler(req(options), res);
  let json = null;
  try { json = JSON.parse(res.body); } catch { /* non-JSON */ }
  return { status: res.status, json };
}

test("ordinary GUI memory CRUD validates input, supports stale checks and preserves data on reset", async () => {
  const h = setup();
  try {
    const created = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/memory",
      body: { type: "project", title: "Synthetic project", content: "First body", importance: 4, tags: ["synthetic"] }
    });
    assert.equal(created.status, 201);
    const id = created.json.data.memory.id;
    assert.equal(created.json.data.action, "created");
    assert.equal((await call(h.route, { url: "/api/amadeus-memory/admin/memories?q=Synthetic" })).json.data.items.length, 1);

    const opened = await call(h.route, { url: `/api/amadeus-memory/admin/memory?id=${encodeURIComponent(id)}` });
    assert.equal(opened.status, 200);
    assert.equal(opened.json.data.content, "First body");
    const revision = opened.json.data.updated_at;

    const updated = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/memory/update",
      body: { id, expected_updated_at: revision, title: "Synthetic project v2", content: "Second body" }
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.json.data.memory.title, "Synthetic project v2");
    assert.equal((await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/memory/update",
      body: { id, expected_updated_at: revision, content: "stale write" }
    })).status, 409);

    assert.equal((await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/memory/archive",
      body: { id, archived: true }
    })).status, 200);
    assert.equal((await call(h.route, { url: "/api/amadeus-memory/admin/memories?archived=1" })).json.data.items.length, 1);

    assert.equal((await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/preferences", body: { action: "reset" }
    })).status, 200);
    assert.equal((await call(h.route, { url: `/api/amadeus-memory/admin/memory?id=${encodeURIComponent(id)}` })).status, 200,
      "resetting preferences must not erase memory");

    assert.equal((await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/memory/delete", body: { id }
    })).status, 400);
    assert.equal((await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/memory/delete", body: { id, confirm: "DELETE" }
    })).status, 200);
    assert.equal((await call(h.route, { url: `/api/amadeus-memory/admin/memory?id=${encodeURIComponent(id)}` })).status, 404);
  } finally {
    h.close();
    h.cleanup();
  }
});

test("ordinary owner edit succeeds with Core disabled", async () => {
  const h = setup({ coreMemoryEnabled: false });
  try {
    const created = await call(h.route, { method: "POST", url: "/api/amadeus-memory/admin/memory",
      body: { type: "project", title: "普通记忆", content: "编辑前" } });
    const id = created.json.data.memory.id;
    const updated = await call(h.route, { method: "POST", url: "/api/amadeus-memory/admin/memory/update",
      body: { id, expected_updated_at: created.json.data.memory.updated_at, content: "编辑后" } });
    assert.equal(updated.status, 200);
    assert.equal(updated.json.data.memory.content, "编辑后");
    assert.equal((await call(h.route, { method: "POST", url: "/api/amadeus-memory/admin/core",
      body: { action: "unprotect", id } })).status, 409);
    assert.equal(h.store.getById(id).content, "编辑后");
  } finally { h.close(); h.cleanup(); }
});

test("memory endpoints reject invalid type, empty content, bad importance and malformed tags", async () => {
  const h = setup();
  try {
    for (const body of [
      { type: "fact", title: "x", content: "y" },
      { type: "document", title: "x", content: "y" },
      { type: "project", title: "", content: "y" },
      { type: "project", title: "x", content: "" },
      { type: "project", title: "x", content: "y", importance: 9 },
      { type: "project", title: "x", content: "y", tags: "not-an-array" }
    ]) {
      assert.equal((await call(h.route, { method: "POST", url: "/api/amadeus-memory/admin/memory", body })).status, 400);
    }
  } finally {
    h.close();
    h.cleanup();
  }
});

test("archived status is authoritative in list/detail and quality-filter auto-archive is visible", async () => {
  const h = setup();
  try {
    const created = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/memory",
      body: { type: "project", title: "Archive boundary", content: "This is a deliberately long synthetic body for archive testing." }
    });
    assert.equal(created.status, 201);
    const id = created.json.data.memory.id;
    assert.equal(created.json.data.memory.archived, false);

    assert.equal((await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/memory/archive",
      body: { id, archived: true }
    })).status, 200);
    let archivedList = await call(h.route, { url: "/api/amadeus-memory/admin/memories?archived=1" });
    const archivedRow = archivedList.json.data.items.find((item) => item.id === id);
    assert.ok(archivedRow, "archived list must include the row");
    assert.equal(archivedRow.archived, true, "archived list must expose the authoritative status");
    assert.equal((await call(h.route, { url: `/api/amadeus-memory/admin/memory?id=${encodeURIComponent(id)}` })).json.data.archived, true);

    assert.equal((await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/memory/archive",
      body: { id, archived: false }
    })).status, 200);
    const activeList = await call(h.route, { url: "/api/amadeus-memory/admin/memories?archived=0" });
    assert.equal(activeList.json.data.items.find((item) => item.id === id)?.archived, false);
    assert.equal((await call(h.route, { url: `/api/amadeus-memory/admin/memory?id=${encodeURIComponent(id)}` })).json.data.archived, false);

    // The default quality policy archives a degenerate short body. The create
    // response must say so immediately instead of making the row appear to vanish.
    const short = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/memory",
      body: { type: "project", title: "Short synthetic", content: "x" }
    });
    assert.equal(short.status, 201);
    assert.equal(short.json.data.memory.archived, true, "quality-filter auto-archive must be visible in the create response");
    const shortArchived = await call(h.route, { url: "/api/amadeus-memory/admin/memories?archived=1" });
    assert.equal(shortArchived.json.data.items.find((item) => item.id === short.json.data.memory.id)?.archived, true);
  } finally {
    h.close();
    h.cleanup();
  }
});

test("scene and recent admin status are bounded and clear is owner-only", async () => {
  const h = setup();
  resetRecentContextForTests();
  configureRecentContext({ enabled: true, ttlMs: 600000, maxEvents: 20, maxTokens: 500 });
  const scene = mintTrustedScene({ platform: "qq", kind: "group", id: "admin-status", verified: true });
  recordTrustedRecentEvent({ eventId: "e1", scene, text: "synthetic recent text", at: Date.now() });
  try {
    const sceneRes = await call(h.route, { url: "/api/amadeus-memory/admin/scene" });
    assert.equal(sceneRes.status, 200);
    const sceneBody = sceneRes.json.data;
    assert.equal(typeof sceneBody.enabled, "boolean");
    assert.equal(typeof sceneBody.strict_qq, "boolean");
    assert.equal(typeof sceneBody.host_contract, "boolean");
    assert.equal(sceneBody.unknown_provenance, "deny");
    assert.equal(sceneBody.legacy_untagged, "readable");
    assert.ok(Array.isArray(sceneBody.grants));
    assert.equal(JSON.stringify(sceneBody).includes("synthetic recent text"), false, "status must not expose bodies");

    const recentRes = await call(h.route, { url: "/api/amadeus-memory/admin/recent" });
    assert.equal(recentRes.status, 200);
    assert.equal(recentRes.json.data.total_events, 1);
    assert.equal(recentRes.json.data.ttl_ms, 600000);
    assert.equal(JSON.stringify(recentRes.json.data).includes("synthetic recent text"), false, "recent counts expose no text");

    const clearRes = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/recent/clear", body: {}
    });
    assert.equal(clearRes.status, 200);
    assert.equal(clearRes.json.data.cleared, true);
    assert.equal(clearRes.json.data.total_events, 0);
    assert.equal((await call(h.route, { url: "/api/amadeus-memory/admin/recent" })).json.data.total_events, 0);
  } finally {
    h.close();
    h.cleanup();
    resetRecentContextForTests();
  }
});

test("owner core management protects, annotates, unprotects and deletes", async () => {
  const h = setup();
  try {
    const created = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/memory",
      body: { type: "history", title: "Core synthetic", content: "A synthetic core memory with enough body length." }
    });
    const id = created.json.data.memory.id;
    let res = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/core",
      body: { action: "protect", id, note: "first person" }
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.memory.protected, true);
    assert.equal(res.json.data.memory.core_note, "first person");

    res = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/core",
      body: { action: "note", id, note: "updated note" }
    });
    assert.equal(res.json.data.memory.core_note, "updated note");
    res = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/core",
      body: { action: "unprotect", id }
    });
    assert.equal(res.json.data.memory.protected, false);

    res = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/core",
      body: { action: "delete", id, confirm: "DELETE" }
    });
    assert.equal(res.status, 200);
    assert.equal((await call(h.route, { url: `/api/amadeus-memory/admin/memory?id=${encodeURIComponent(id)}` })).status, 404);
  } finally {
    h.close();
    h.cleanup();
  }
});

test("owner correction replaces protected fact and invalidates old vector and graph", async () => {
  const h = setup();
  try {
    const created = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/memory",
      body: { type: "history", title: "管理员喜欢小雨", content: "管理员喜欢小雨。", importance: 5 }
    });
    const id = created.json.data.memory.id;
    await call(h.route, { method: "POST", url: "/api/amadeus-memory/admin/core",
      body: { action: "protect", id, note: "旧短记" } });
    const entity = h.store.createEntity({ name: "管理员", type: "person" });
    const other = h.store.createEntity({ name: "小雨", type: "person" });
    h.store.saveAttr({ entity_id: entity.id, attr_key: "喜欢", attr_value: "小雨", memory_id: id });
    h.store.saveRelation({ from_entity: entity.id, to_entity: other.id, relation_type: "喜欢", memory_id: id });
    h.store.setEmbedding(id, [1, 0]);
    const before = h.store.getById(id);
    assert.throws(() => h.service.update(id, { content: "模型篡改" }), /PROTECTED_MEMORY/);
    assert.equal(h.store.remove(id), false);
    const revised = await call(h.route, { method: "POST", url: "/api/amadeus-memory/admin/memory/update",
      body: { id, expected_updated_at: before.updated_at, title: "管理员关系已改变",
        content: "管理员以前喜欢小雨，现在已经不喜欢了。" } });
    assert.equal(revised.status, 200);
    assert.equal(revised.json.data.memory.protected, true);
    assert.equal(h.store.getById(id).content_history.length, 0);
    assert.equal(h.store.getById(id).embedding, undefined);
    assert.equal(h.store.getCurrentAttrs(entity.id).length, 0);
    assert.equal(h.store.getRelations(entity.id).length, 0);
    assert.equal((await h.service.searchMemories("关系已改变"))[0].content, "管理员以前喜欢小雨，现在已经不喜欢了。");
    const note = await call(h.route, { method: "POST", url: "/api/amadeus-memory/admin/core",
      body: { action: "note", id, note: "现在以他的修订为准" } });
    assert.equal(note.status, 200);
    h.close();
    const reopened = createStore(join(h.dir, "memory.db"));
    assert.equal(reopened.getById(id).protected, true);
    assert.equal(reopened.getById(id).core_note, "现在以他的修订为准");
    assert.equal(reopened.getById(id).content, "管理员以前喜欢小雨，现在已经不喜欢了。");
    reopened.close();
  } finally { h.close(); h.cleanup(); }
});

test("owner feature API persists Scene, Recent and Core switches for the native settings page", async () => {
  const h = setup();
  try {
    const keys = ["sceneIsolationEnabled", "sceneStrictQQ", "recentContextEnabled", "coreMemoryEnabled"];
    const enabled = Object.fromEntries(keys.map((key) => [key, true]));
    assert.equal((await call(h.route, { method: "POST", url: "/api/amadeus-memory/admin/features", body: enabled })).status, 200);
    let state = await call(h.route, { url: "/api/amadeus-memory/admin/features" });
    for (const key of keys) assert.equal(state.json.data.effective[key], true);
    assert.equal((await call(h.route, { method: "POST", url: "/api/amadeus-memory/admin/features",
      body: Object.fromEntries(keys.map((key) => [key, false])) })).status, 200);
    state = await call(h.route, { url: "/api/amadeus-memory/admin/features" });
    for (const key of keys) assert.equal(state.json.data.effective[key], false);
    h.close();
    const reopened = createStore(join(h.dir, "memory.db"));
    const settings = createSettings(reopened.db);
    for (const key of keys) assert.equal(settings.getFeatureFlags()[key], false);
    reopened.close();
  } finally { h.close(); h.cleanup(); }
});

test("backup, preflight and staged restore are owner-only and data-preserving", async () => {
  const h = setup();
  try {
    const created = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/memory",
      body: { type: "project", title: "Backup boundary", content: "must survive" }
    });
    assert.equal(created.status, 201);
    const backup = await call(h.route, { method: "POST", url: "/api/amadeus-memory/admin/backup", body: {} });
    assert.equal(backup.status, 201);
    const info = backup.json.data;
    assert.match(info.name, /\.db$/);
    assert.equal((await call(h.route, { url: "/api/amadeus-memory/admin/backups" })).json.data.items.length, 1);
    assert.equal((await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/restore/check", body: { backup: info.name }
    })).status, 200);
    assert.equal((await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/restore", body: { backup: info.name, confirm: "NOPE" }
    })).status, 400);
    assert.equal((await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/restore",
      body: { backup: info.name, sha256: "0".repeat(64), confirm: "RESTORE" }
    })).status, 409);
    const staged = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/restore",
      body: { backup: info.name, sha256: info.sha256, confirm: "RESTORE" }
    });
    assert.equal(staged.status, 200);
    assert.equal(staged.json.data.restart_required, true);
    assert.equal(h.service.count(), 1, "staging must not modify the live database before restart");

    h.close();
    const applied = applyStagedRestore(h.dir);
    assert.equal(applied.applied, true);
    const reopened = createStore(join(h.dir, "memory.db"));
    try {
      assert.equal(reopened.count(), 1);
    } finally {
      reopened.db.close();
    }
  } finally {
    h.close();
    h.cleanup();
  }
});
