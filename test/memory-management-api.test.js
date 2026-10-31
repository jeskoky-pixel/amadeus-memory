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
import { mintTrustedScene, runWithTrustedScene, configureScene, resetSceneStateForTests } from "../src/scene.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", ".test-tmp");
mkdirSync(ROOT, { recursive: true });
let seq = 0;

function setup({ coreMemoryEnabled = true, principal = "owner" } = {}) {
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
    connection: { admit() { return { peer: { principal: { kind: principal } } }; } },
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
function req({ method = "GET", url = "/", body, headers = {} } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return {
    method, url,
    headers: { host: "127.0.0.1:5119", origin: "http://127.0.0.1:5119", "content-type": "application/json", "x-amadeus-memory": "1", ...headers },
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

test("owner scene graph is scope-validated, evidence-only, bounded and excludes archived/forgotten", async () => {
  const h = setup();
  try {
    const a1 = h.store.save({ type: "history", title: "A1", content: "secret body A1", scene_scope: "qq:group:a" });
    const a2 = h.store.save({ type: "history", title: "A2", content: "secret body A2", scene_scope: "qq:group:a" });
    const b1 = h.store.save({ type: "history", title: "B1", content: "secret body B1", scene_scope: "qq:group:b" });
    const p1 = h.store.save({ type: "history", title: "P1", content: "secret private body", scene_scope: "qq:private:admin" });
    const legacy = h.store.save({ type: "history", title: "L1", content: "secret legacy body" });
    const archived = h.store.save({ type: "history", title: "archived", content: "secret archived body", scene_scope: "qq:group:a" });
    h.store.setArchived(archived.id, true);
    const forgotten = h.store.save({ type: "history", title: "forgotten", content: "secret forgotten body", scene_scope: "qq:group:b" });
    h.store.setForget(forgotten.id, true);

    const alice = h.store.createEntity({ name: "Alice", type: "person" });
    const bob = h.store.createEntity({ name: "Bob", type: "person" });
    const carol = h.store.createEntity({ name: "Carol", type: "person" });
    const ghost = h.store.createEntity({ name: "Ghost", type: "person" });
    const legacyEntity = h.store.createEntity({ name: "Legacy", type: "person" });
    const privateEntity = h.store.createEntity({ name: "PrivatePerson", type: "person" });
    const archivedEntity = h.store.createEntity({ name: "ArchivedEntity", type: "person" });
    const forgottenEntity = h.store.createEntity({ name: "ForgottenEntity", type: "person" });
    h.store.createEntity({ name: "NoEvidence", type: "person" });
    h.store.saveAttr({ entity_id: alice.id, attr_key: "likes", attr_value: "A-only", memory_id: a1.id });
    h.store.saveAttr({ entity_id: bob.id, attr_key: "likes", attr_value: "A-only", memory_id: a2.id });
    h.store.saveAttr({ entity_id: carol.id, attr_key: "likes", attr_value: "B-only", memory_id: b1.id });
    h.store.saveAttr({ entity_id: legacyEntity.id, attr_key: "likes", attr_value: "legacy", memory_id: legacy.id });
    h.store.saveAttr({ entity_id: privateEntity.id, attr_key: "likes", attr_value: "private", memory_id: p1.id });
    h.store.saveAttr({ entity_id: archivedEntity.id, attr_key: "likes", attr_value: "archived", memory_id: archived.id });
    h.store.saveAttr({ entity_id: forgottenEntity.id, attr_key: "likes", attr_value: "forgotten", memory_id: forgotten.id });
    const edgeA = h.store.saveRelation({ from_entity: alice.id, to_entity: bob.id, relation_type: "knows", memory_id: a1.id });
    h.store.saveRelation({ from_entity: carol.id, to_entity: ghost.id, relation_type: "knows", memory_id: b1.id });
    h.store.saveRelation({ from_entity: alice.id, to_entity: archivedEntity.id, relation_type: "archived-edge", memory_id: archived.id });
    h.store.saveRelation({ from_entity: carol.id, to_entity: forgottenEntity.id, relation_type: "forgotten-edge", memory_id: forgotten.id });

    const scopes = await call(h.route, { url: "/api/amadeus-memory/admin/graph/scopes" });
    assert.equal(scopes.status, 200);
    const byScope = new Map(scopes.json.data.items.map((row) => [row.scope, row]));
    assert.equal(byScope.get("qq:group:a").active, 2);
    assert.equal(byScope.get("qq:group:b").active, 1);
    assert.equal(byScope.get("qq:private:admin").active, 1);
    assert.equal(byScope.get("legacy").active, 1);
    assert.equal(JSON.stringify(scopes.json.data).includes("secret"), false);

    const graphA = await call(h.route, { url: "/api/amadeus-memory/admin/graph?scope=qq:group:a" });
    assert.equal(graphA.status, 200);
    assert.deepEqual(graphA.json.data.nodes.map((node) => node.name).sort(), ["Alice", "Bob"]);
    assert.deepEqual(graphA.json.data.edges, [{
      id: edgeA.id, from: alice.id, to: bob.id, relation_type: "knows", weight: 1, source: "manual"
    }]);
    assert.equal(JSON.stringify(graphA.json.data).includes("secret"), false);
    assert.equal(JSON.stringify(graphA.json.data).includes("memory_id"), false);

    const graphB = await call(h.route, { url: "/api/amadeus-memory/admin/graph?scope=qq:group:b" });
    assert.deepEqual(graphB.json.data.nodes.map((node) => node.name).sort(), ["Carol", "Ghost"]);
    assert.equal(graphB.json.data.nodes.some((node) => node.name === "Alice"), false);

    const graphLegacy = await call(h.route, { url: "/api/amadeus-memory/admin/graph?scope=legacy" });
    assert.deepEqual(graphLegacy.json.data.nodes.map((node) => node.name), ["Legacy"]);

    const graphPrivate = await call(h.route, { url: "/api/amadeus-memory/admin/graph?scope=qq:private:admin" });
    assert.deepEqual(graphPrivate.json.data.nodes.map((node) => node.name), ["PrivatePerson"]);
    assert.equal(graphPrivate.json.data.nodes.some((node) => node.name === "Alice"), false);
    assert.equal(graphA.json.data.nodes.some((node) => node.name === "ArchivedEntity" || node.name === "ForgottenEntity"), false);
    assert.equal(graphB.json.data.nodes.some((node) => node.name === "ArchivedEntity" || node.name === "ForgottenEntity"), false);

    assert.equal((await call(h.route, { url: "/api/amadeus-memory/admin/graph" })).status, 400);
    assert.equal((await call(h.route, { url: "/api/amadeus-memory/admin/graph?scope=qq:group:nope" })).status, 400);
    assert.equal((await call(h.route, {
      url: "/api/amadeus-memory/admin/graph?scope=qq:group:a",
      headers: { origin: "http://evil.example" }
    })).status, 403);
    const bounded = await call(h.route, { url: "/api/amadeus-memory/admin/graph?scope=qq:group:a&node_limit=1&edge_limit=1" });
    assert.ok(bounded.json.data.nodes.length <= 1);
    assert.equal(bounded.json.data.truncated, true);

    // Relation endpoints win the bounded node slots over attr-only entities.
    const capMem = h.store.save({ type: "history", title: "cap", content: "cap body", scene_scope: "qq:group:cap" });
    const capFrom = h.store.createEntity({ name: "CapFrom", type: "person" });
    const capTo = h.store.createEntity({ name: "CapTo", type: "person" });
    for (let i = 0; i < 6; i += 1) {
      const attrEntity = h.store.createEntity({ name: `CapAttr${i}`, type: "person" });
      h.store.saveAttr({ entity_id: attrEntity.id, attr_key: "likes", attr_value: "cap", memory_id: capMem.id });
    }
    h.store.saveRelation({ from_entity: capFrom.id, to_entity: capTo.id, relation_type: "cap-edge", memory_id: capMem.id });
    const capGraph = await call(h.route, {
      url: "/api/amadeus-memory/admin/graph?scope=qq:group:cap&node_limit=2&edge_limit=10"
    });
    assert.deepEqual(capGraph.json.data.nodes.map((node) => node.name).sort(), ["CapFrom", "CapTo"]);
    assert.equal(capGraph.json.data.edges.length, 1, "prioritized relation endpoints must keep the edge visible");
    assert.equal(capGraph.json.data.truncated, true);

    const anonymous = setup({ principal: "anonymous" });
    try {
      assert.equal((await call(anonymous.route, { url: "/api/amadeus-memory/admin/graph?scope=legacy" })).status, 403);
    } finally {
      anonymous.close(); anonymous.cleanup();
    }
  } finally {
    h.close();
    h.cleanup();
  }
});

test("owner ACL API is directional, persistent, same-origin and merged graph is explicit", async () => {
  const h = setup();
  try {
    const a = mintTrustedScene({ platform: "qq", kind: "group", id: "bot:acl-a", verified: true });
    const b = mintTrustedScene({ platform: "qq", kind: "group", id: "bot:acl-b", verified: true });
    const c = mintTrustedScene({ platform: "qq", kind: "group", id: "bot:acl-c", verified: true });
    const aRow = runWithTrustedScene(a, () => h.service.saveWithDedupe({ type: "history", title: "ACL A", content: "This is a synthetic long-form memory body used only for the ACL API regression; it intentionally contains enough substantive prose to avoid short-content quality filtering while remaining entirely fabricated and non-production.", importance: 3 }));
    const bRow = runWithTrustedScene(b, () => h.service.saveWithDedupe({ type: "history", title: "ACL B", content: "This is a synthetic long-form memory body used only for the ACL API regression; it intentionally contains enough substantive prose to avoid short-content quality filtering while remaining entirely fabricated and non-production.", importance: 3 }));
    h.service.setArchived(aRow.memory.id, false);
    h.service.setArchived(bRow.memory.id, false);
    const acl = await call(h.route, { url: "/api/amadeus-memory/admin/acl" });
    assert.equal(acl.status, 200);
    assert.equal(acl.json.data.scenes.some((row) => row.scope === a.sceneId), true);

    const denied = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/acl/grant",
      body: { reader_scene: a.sceneId, source_scene: b.sceneId },
      headers: { origin: "http://evil.example" }
    });
    assert.equal(denied.status, 403);
    const grantBeforeMemory = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/acl/grant",
      body: { reader_scene: a.sceneId, source_scene: c.sceneId }
    });
    assert.equal(grantBeforeMemory.status, 200, "a canonical group can be granted before it has memories");
    const revokeBeforeMemory = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/acl/revoke",
      body: { reader_scene: a.sceneId, source_scene: c.sceneId }
    });
    assert.equal(revokeBeforeMemory.status, 200);
    const numericGrant = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/acl/grant",
      body: { bot: "123456", reader_group: "10001", source_group: "10002" }
    });
    assert.equal(numericGrant.status, 200);
    assert.equal(numericGrant.json.data.reader_scene, "qq:group:123456:10001");
    assert.equal(numericGrant.json.data.source_scene, "qq:group:123456:10002");
    const numericRevoke = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/acl/revoke",
      body: { bot: "123456", reader_group: "10001", source_group: "10002" }
    });
    assert.equal(numericRevoke.status, 200);
    const privateGrant = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/acl/grant",
      body: { reader_scene: a.sceneId, source_scene: "qq:private:bot:peer" }
    });
    assert.equal(privateGrant.status, 400, "private Scenes are not valid allowlist sources");
    const grant = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/acl/grant",
      body: { reader_scene: a.sceneId, source_scene: b.sceneId }
    });
    assert.equal(grant.status, 200);
    assert.equal(grant.json.data.created, true);
    assert.equal(h.store.hasSceneReadGrant(a.sceneId, b.sceneId), true);
    assert.equal(h.store.hasSceneReadGrant(b.sceneId, a.sceneId), false, "grant is directional");

    const graph = await call(h.route, { url: "/api/amadeus-memory/admin/graph?scopes=all" });
    assert.equal(graph.status, 200);
    assert.deepEqual(graph.json.data.scopes.sort(), [a.sceneId, b.sceneId]);
    const buckets = await call(h.route, { url: `/api/amadeus-memory/admin/memories?scenes=${encodeURIComponent(a.sceneId)}` });
    assert.equal(buckets.status, 200);
    assert.deepEqual(buckets.json.data.items.map((row) => row.scene_scope), [a.sceneId]);
    assert.equal(buckets.json.data.items.some((row) => row.title === "ACL B"), false);
    const multi = await call(h.route, { url: `/api/amadeus-memory/admin/memories?scenes=${encodeURIComponent(a.sceneId + "," + b.sceneId)}` });
    assert.equal(multi.status, 200);
    assert.deepEqual(new Set(multi.json.data.items.map((row) => row.scene_scope)), new Set([a.sceneId, b.sceneId]));
    const chrono = await call(h.route, { url: `/api/amadeus-memory/admin/memories?scenes=all&order=chrono` });
    assert.equal(chrono.status, 200);
    assert.equal(chrono.json.data.items.length >= 2, true);
    const bCurrent = h.store.getById(bRow.memory.id);
    const browserEdit = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/memory/update",
      body: { id: bCurrent.id, expected_updated_at: bCurrent.updated_at, title: "ACL B edited by owner" }
    });
    assert.equal(browserEdit.status, 200, "owner browser edit may manage any selected Scene");
    assert.equal(h.store.getById(bCurrent.id).title, "ACL B edited by owner");

    const revoke = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/acl/revoke",
      body: { reader_scene: a.sceneId, source_scene: b.sceneId }
    });
    assert.equal(revoke.status, 200);
    assert.equal(h.store.hasSceneReadGrant(a.sceneId, b.sceneId), false);
    // Revocation also works after the source group's last memory is deleted.
    h.store.remove(bRow.memory.id);
    const regrant = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/acl/grant",
      body: { reader_scene: a.sceneId, source_scene: b.sceneId }
    });
    assert.equal(regrant.status, 200);
    const revokeAfterDelete = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/acl/revoke",
      body: { reader_scene: a.sceneId, source_scene: b.sceneId }
    });
    assert.equal(revokeAfterDelete.status, 200);
    assert.equal(aRow.memory.id.length > 0, true);
  } finally { h.close(); h.cleanup(); }
});

test("owner full memory detail returns complete long content for explorer editing", async () => {
  const h = setup();
  try {
    const body = "Long synthetic body. ".repeat(60);
    const created = h.service.saveWithDedupe({ type: "history", title: "long detail", content: body, importance: 3 });
    const detail = await call(h.route, { url: `/api/amadeus-memory/admin/memory?id=${created.memory.id}` });
    assert.equal(detail.status, 200);
    assert.equal(detail.json.data.content.length, body.length);
    assert.equal(detail.json.data.content, body);
    const update = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/memory/update",
      body: { id: created.memory.id, expected_updated_at: detail.json.data.updated_at, content: body + " edited" }
    });
    assert.equal(update.status, 200);
    assert.equal(h.store.getById(created.memory.id).content, body + " edited");
  } finally { h.close(); h.cleanup(); }
});

test("numeric allowlist derives a single known bot and rejects ambiguous/multi-bot guesses", async () => {
  const h = setup();
  try {
    const one = mintTrustedScene({ platform: "qq", kind: "group", id: "999:10001", verified: true });
    const two = mintTrustedScene({ platform: "qq", kind: "group", id: "999:10002", verified: true });
    runWithTrustedScene(one, () => h.service.saveWithDedupe({ type: "history", title: "one", content: "synthetic one body long enough for quality filter" }));
    runWithTrustedScene(two, () => h.service.saveWithDedupe({ type: "history", title: "two", content: "synthetic two body long enough for quality filter" }));
    const grant = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/acl/grant",
      body: { reader_group: "10001", source_group: "10002" }
    });
    assert.equal(grant.status, 200);
    assert.equal(grant.json.data.reader_scene, "qq:group:999:10001");
    assert.equal(grant.json.data.source_scene, "qq:group:999:10002");
    assert.equal(grant.json.data.state.scenes.some((row) => row.scope === "qq:group:999:10001"), true);
  } finally { h.close(); h.cleanup(); }
});

test("owner personalization API saves profile/persona and returns real injection preview", async () => {
  const h = setup();
  configureScene({ enabled: true, strictQQ: true, hostContract: true });
  try {
    const initial = await call(h.route, { url: "/api/amadeus-memory/admin/personalization" });
    assert.equal(initial.status, 200);
    assert.equal(typeof initial.json.data.profile, "string");
    assert.ok(initial.json.data.persona && initial.json.data.persona.default);
    const profile = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/personalization/profile",
      body: { profile: "synthetic owner profile" }
    });
    assert.equal(profile.status, 200);
    assert.equal(profile.json.data.profile, "synthetic owner profile");
    const persona = await call(h.route, {
      method: "POST", url: "/api/amadeus-memory/admin/personalization/persona",
      body: { persona: { default: { name: "Synthetic", personality: "calm", replyStyle: "brief", enabled: true }, byAgent: {} } }
    });
    assert.equal(persona.status, 200);
    assert.equal(persona.json.data.persona.default.name, "Synthetic");
    const reload = await call(h.route, { url: "/api/amadeus-memory/admin/personalization" });
    assert.equal(reload.json.data.profile, "synthetic owner profile");
    assert.equal(reload.json.data.persona.default.name, "Synthetic");
    assert.ok(String(reload.json.data.preview?.text ?? "").includes("synthetic owner profile"),
      "preview must come from the real injection renderer");
  } finally { resetSceneStateForTests(); h.close(); h.cleanup(); }
});

test("owner selected-Scene memory list filters in SQL before LIMIT", async () => {
  const h = setup();
  try {
    const a = mintTrustedScene({ platform: "qq", kind: "group", id: "bot:selected-a", verified: true });
    const c = mintTrustedScene({ platform: "qq", kind: "group", id: "bot:selected-c", verified: true });
    for (let i = 0; i < 1005; i += 1) {
      h.store.save({ type: "history", title: `other ${i}`, content: "unrelated synthetic", importance: 5, scene_scope: c.sceneId });
    }
    runWithTrustedScene(a, () => h.service.saveWithDedupe({
      type: "history", title: "selected low rank",
      content: "synthetic selected low rank body that survives quality filtering", importance: 1
    }));
    const page = await call(h.route, {
      url: `/api/amadeus-memory/admin/memories?scenes=${encodeURIComponent(a.sceneId)}&limit=1&offset=0`
    });
    assert.equal(page.status, 200);
    assert.equal(page.json.data.total, 1);
    assert.equal(page.json.data.items[0].title, "selected low rank");
  } finally { h.close(); h.cleanup(); }
});

test("owner keyword search applies Scene/type/importance/date and archived-only in SQL", async () => {
  const h = setup();
  try {
    const a = mintTrustedScene({ platform: "qq", kind: "group", id: "bot:combo-a", verified: true });
    const c = mintTrustedScene({ platform: "qq", kind: "group", id: "bot:combo-c", verified: true });
    const body = "combo-keyword synthetic body long enough to avoid quality filtering";
    const target = runWithTrustedScene(a, () => h.service.saveWithDedupe({ type: "history", title: "target combo", content: body, importance: 4 }));
    const activeA = runWithTrustedScene(a, () => h.service.saveWithDedupe({ type: "history", title: "active combo", content: body, importance: 4 }));
    const otherScene = runWithTrustedScene(c, () => h.service.saveWithDedupe({ type: "history", title: "other combo", content: body, importance: 4 }));
    const otherType = runWithTrustedScene(a, () => h.service.saveWithDedupe({ type: "decision", title: "decision combo", content: body, importance: 4 }));
    const low = runWithTrustedScene(a, () => h.service.saveWithDedupe({ type: "history", title: "low combo", content: body, importance: 1 }));
    for (const row of [target, otherScene, otherType, low]) h.service.setArchived(row.memory.id, true);
    const from = new Date(Date.now() - 86400000).toISOString();
    const result = await call(h.route, {
      url: `/api/amadeus-memory/admin/memories?q=combo&scenes=${encodeURIComponent(a.sceneId)}&type=history&min_importance=3&archived=1&updated_from=${encodeURIComponent(from)}&limit=10`
    });
    assert.equal(result.status, 200);
    assert.equal(result.json.data.total, 1);
    assert.deepEqual(result.json.data.items.map((row) => row.title), ["target combo"]);
    assert.equal(result.json.data.items.some((row) => row.title === "active combo"), false);
    assert.equal(activeA.memory.id.length > 0, true);
  } finally { h.close(); h.cleanup(); }
});

test("owner status endpoint returns real audit totals and daily rows", async () => {
  const h = setup();
  try {
    h.store.saveLlmAudit({
      trigger_source: "test", operation_type: "summarize", model_id: "fake",
      input_tokens: 10, output_tokens: 5, total_tokens: 15, status: "success"
    });
    const status = await call(h.route, { url: "/api/amadeus-memory/admin/status" });
    assert.equal(status.status, 200);
    assert.equal(status.json.data.audit.total_calls, 1);
    assert.equal(status.json.data.audit.total_tokens, 15);
    assert.ok(Array.isArray(status.json.data.audit.by_day) && status.json.data.audit.by_day.length >= 1);
    assert.equal(status.json.data.audit.by_day[0].total_tokens, 15);
    assert.equal(status.json.data.audit.by_operation[0].total_tokens, 15);
  } finally { h.close(); h.cleanup(); }
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

test("owner feature API persists Scene/Core switches and keeps retired Recent Context and Life intake false", async () => {
  const h = setup();
  try {
    const activeKeys = ["sceneIsolationEnabled", "sceneStrictQQ", "coreMemoryEnabled"];
    const retiredKeys = ["recentContextEnabled", "trustedIntakeEnabled"];
    const allKeys = [...activeKeys, ...retiredKeys];
    const enabled = Object.fromEntries(allKeys.map((key) => [key, true]));
    assert.equal((await call(h.route, { method: "POST", url: "/api/amadeus-memory/admin/features", body: enabled })).status, 200);
    let state = await call(h.route, { url: "/api/amadeus-memory/admin/features" });
    for (const key of activeKeys) assert.equal(state.json.data.effective[key], true);
    for (const key of retiredKeys) {
      assert.equal(state.json.data.effective[key], false, `${key} must not report enabled after retirement`);
    }
    assert.equal((await call(h.route, { method: "POST", url: "/api/amadeus-memory/admin/features",
      body: Object.fromEntries(allKeys.map((key) => [key, false])) })).status, 200);
    state = await call(h.route, { url: "/api/amadeus-memory/admin/features" });
    for (const key of allKeys) assert.equal(state.json.data.effective[key], false);
    h.close();
    const reopened = createStore(join(h.dir, "memory.db"));
    const settings = createSettings(reopened.db);
    for (const key of allKeys) assert.equal(settings.getFeatureFlags()[key], false);
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
