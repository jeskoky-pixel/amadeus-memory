import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { assertIsolatedMemoryDir } from "../src/qa-guard.js";
import {
  mintTrustedScene, runWithTrustedScene, configureScene, grantSceneRead,
  resetSceneStateForTests, sceneIdOf, normalizeScene, isExplicitCoreRequest
} from "../src/scene.js";
import {
  configureRecentContext, recordTrustedRecentEvent, readRecentContext,
  recentContextCounts, resetRecentContextForTests
} from "../src/recent-context.js";
import { createRouteRegistrar } from "../src/api.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", ".test-tmp");
mkdirSync(ROOT, { recursive: true });

const baseConfig = {
  language: "zh", autoInject: true, autoSummarize: false, autoDream: false,
  sleepModeEnabled: false, entityExtractionEnabled: false, memoryPreferenceEnabled: false,
  trustedIntakeEnabled: false, rerankEnabled: false, entitySearchEnabled: true,
  embeddingEnabled: false, embedProvider: "openai", memoryQualityFilter: { enabled: false },
  sceneIsolationEnabled: true, sceneStrictQQ: true, coreMemoryEnabled: true,
  recentContextEnabled: true, recentContextTtlMs: 600000, recentContextMaxEvents: 3,
  recentContextMaxTokens: 500, llmAudit: { enabled: true }
};

function setup(tag = "scene") {
  const dir = assertIsolatedMemoryDir(join(ROOT, `${tag}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`), { qaRoot: ROOT });
  const store = createStore(join(dir, "memory.db"));
  const service = createService({ store, mirror: null, config: baseConfig });
  return {
    dir, store, service,
    close() { try { store.close(); } catch { /* closed */ } },
    cleanup() { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
  };
}

function scenes() {
  const groupA = mintTrustedScene({ platform: "qq", kind: "group", id: "group-a", verified: true });
  const groupB = mintTrustedScene({ platform: "qq", kind: "group", id: "group-b", verified: true });
  const admin = mintTrustedScene({ platform: "qq", kind: "private", id: "admin-private", verified: true, admin: true });
  return { groupA, groupB, admin };
}

test("group B secret never reaches group A through search, inject, graph attr, or forged scene", async () => {
  resetSceneStateForTests();
  resetRecentContextForTests();
  configureScene({ enabled: true, strictQQ: true, hostContract: true });
  const { groupA, groupB, admin } = scenes();
  const h = setup("secrecy");
  try {
    assert.equal(sceneIdOf(groupA), "qq:group:group-a");
    assert.equal(normalizeScene({ platform: "qq", kind: "group", id: "group-a", verified: true }), null,
      "plain lookalike object is not a capability");
    assert.throws(() => runWithTrustedScene({ platform: "qq", kind: "group", id: "group-a", verified: true }, () => {}), /SCENE_UNVERIFIED/);

    const secret = runWithTrustedScene(groupB, () => h.service.saveWithDedupe({
      type: "history", title: "管理员喜欢小雨", content: "管理员喜欢小雨，这是群 B 的私密事实。", importance: 5
    }));
    assert.equal(secret.memory.scene_scope, groupB.sceneId);

    const publicA = runWithTrustedScene(groupA, () => h.service.saveWithDedupe({
      type: "history", title: "群 A 的公开安排", content: "群 A 明天下午讨论公开安排。", importance: 3
    }));
    assert.equal(publicA.memory.scene_scope, groupA.sceneId);

    // Caller-supplied authority fields are data, not capability.
    const forged = runWithTrustedScene(groupA, () => h.service.saveWithDedupe({
      type: "history", title: "伪造场景", content: "试图写入群 B 的场景归属。",
      scene_scope: groupB.sceneId, protected: true, core_note: "forged"
    }));
    assert.equal(forged.memory.scene_scope, groupA.sceneId);
    assert.equal(forged.memory.protected, false);
    assert.equal(forged.memory.core_note, undefined);
    runWithTrustedScene(groupA, () => h.service.update(forged.memory.id, {
      title: "伪造更新", scene_scope: groupB.sceneId, protected: true, core_note: "forged"
    }));
    assert.equal(h.store.getById(forged.memory.id).scene_scope, groupA.sceneId);
    assert.equal(h.store.getById(forged.memory.id).protected, false);

    // Keyword, entity/attr search, injection and a forged scene all stay blind.
    assert.equal((await runWithTrustedScene(groupA, () => h.service.searchMemories("小雨"))).length, 0);
    assert.equal((await runWithTrustedScene(groupA, () => h.service.searchMemories("管理员"))).length, 0);
    assert.ok((await runWithTrustedScene(groupA, () => h.service.injectCandidates({ query: "管理员喜欢谁", maxItems: 5 }))).every((row) => row.id !== secret.memory.id));
    assert.equal((await runWithTrustedScene(admin, () => h.service.searchMemories("小雨"))).length, 1, "verified owner admin reads all Scenes");

    // Graph attrs do not expire across scenes, and attr search is scene filtered.
    const entity = h.store.createEntity({ name: "管理员", type: "person" });
    h.store.saveAttr({ entity_id: entity.id, attr_key: "喜欢", attr_value: "小雨", memory_id: secret.memory.id });
    h.store.saveAttr({ entity_id: entity.id, attr_key: "喜欢", attr_value: "晴", memory_id: publicA.memory.id });
    const live = h.store.getCurrentAttrs(entity.id).filter((row) => row.attr_key === "喜欢");
    assert.equal(live.length, 2, "scene B write must not invalidate scene A attr");
    h.store.saveAttr({ entity_id: entity.id, attr_key: "喜欢", attr_value: "未知来源", memory_id: null });
    const afterUnknown = h.store.getCurrentAttrs(entity.id).filter((row) => row.attr_key === "喜欢");
    assert.equal(afterUnknown.filter((row) => row.memory_id === secret.memory.id || row.memory_id === publicA.memory.id).length, 2,
      "memory_id-less attr write must not expire scene A/B attrs");
    assert.equal(afterUnknown.filter((row) => row.memory_id === undefined).length, 1);
    assert.equal((await runWithTrustedScene(groupA, () => h.service.searchMemories("attr:喜欢"))).length, 1);
    assert.ok((await runWithTrustedScene(groupA, () => h.service.searchMemories("attr:喜欢"))).every((row) => row.scene_scope === groupA.sceneId));

    // Admin private is a Host capability: it reads group B without a grant.
    assert.equal((await runWithTrustedScene(admin, () => h.service.searchMemories("小雨"))).length, 1);
    assert.equal((await runWithTrustedScene(groupA, () => h.service.searchMemories("小雨"))).length, 0,
      "group A does not inherit owner access");
    assert.throws(() => grantSceneRead(admin, { platform: "qq", kind: "group", id: "group-b", verified: true }), /SCENE_UNVERIFIED/);
  } finally {
    h.close();
    h.cleanup();
  }
});

test("Recent Context is bounded, deduped, directional, expiring and in-memory only", async () => {
  resetSceneStateForTests();
  resetRecentContextForTests();
  configureScene({ enabled: true, strictQQ: true, hostContract: true });
  configureRecentContext({ enabled: true, ttlMs: 1000, maxEvents: 3, maxTokens: 500 });
  const { groupA, groupB, admin } = scenes();
  try {
    const t0 = Date.now();
    assert.equal(recordTrustedRecentEvent({ eventId: "b1", scene: groupB, text: "群 B 的秘密小雨", at: t0 }).ok, true);
    assert.equal(recordTrustedRecentEvent({ eventId: "b1", scene: groupB, text: "重复", at: t0 }).ok, false);
    assert.equal(recordTrustedRecentEvent({ eventId: "b2", scene: groupB, text: "群 B 第二件事", at: t0 + 1 }).ok, true);
    assert.equal(recordTrustedRecentEvent({ eventId: "b3", scene: groupB, text: "群 B 第三件事", at: t0 + 2 }).ok, true);
    assert.equal(recordTrustedRecentEvent({ eventId: "b4", scene: groupB, text: "群 B 第四件事", at: t0 + 3 }).ok, true);

    assert.equal(readRecentContext({ outputScene: groupA, now: t0 + 4 }).length, 0);
    const seen = readRecentContext({ outputScene: admin, now: t0 + 4 });
    assert.equal(seen.length, 3, "verified owner admin reads all Recent Scenes; maxEvents=3 evicts the oldest");
    assert.equal(new Set(seen.map((e) => e.eventId)).size, 3);
    assert.equal(seen.some((e) => e.eventId === "b1"), false);
    assert.equal(readRecentContext({ outputScene: admin, now: t0 + 1005 }).length, 0, "TTL expires");

    // A private event never flows into a group, even with a grant attempt.
    recordTrustedRecentEvent({ eventId: "p1", scene: admin, text: "私聊秘密", at: t0 });
    assert.equal(readRecentContext({ outputScene: groupB, now: t0 }).some((e) => e.text.includes("私聊秘密")), false);
    resetRecentContextForTests();
    assert.equal(readRecentContext({ outputScene: admin, now: t0 }).length, 0, "restart/clear drops the buffer");
  } finally {
    resetRecentContextForTests();
  }
});

test("Recent Context prunes expired IDs/scenes and keeps dedupe bounded", () => {
  resetSceneStateForTests();
  resetRecentContextForTests();
  configureScene({ enabled: true, strictQQ: true, hostContract: true });
  configureRecentContext({ enabled: true, ttlMs: 1000, maxEvents: 2, maxTokens: 500 });
  try {
    const group = mintTrustedScene({ platform: "qq", kind: "group", id: "cleanup", verified: true });
    const base = Date.now();
    assert.equal(recordTrustedRecentEvent({ eventId: "e1", scene: group, text: "one", at: base }).ok, true);
    assert.equal(recordTrustedRecentEvent({ eventId: "e1", scene: group, text: "dup", at: base + 1 }).ok, false);
    assert.equal(recordTrustedRecentEvent({ eventId: "e2", scene: group, text: "two", at: base + 2 }).ok, true);
    assert.equal(recordTrustedRecentEvent({ eventId: "e3", scene: group, text: "three", at: base + 3 }).ok, true);
    assert.equal(readRecentContext({ outputScene: group, now: base + 3 }).length, 2, "maxEvents eviction");
    assert.equal(recordTrustedRecentEvent({ eventId: "bad", scene: group, text: "bad", at: Number.NaN }).ok, false);
    // Reading after TTL prunes retained IDs; the same ID is valid again.
    assert.equal(readRecentContext({ outputScene: group, now: base + 5000 }).length, 0);
    assert.equal(recentContextCounts().length, 0, "expired scene entries are removed on read");
    const freshAt = Date.now();
    assert.equal(recordTrustedRecentEvent({ eventId: "e2", scene: group, text: "fresh", at: freshAt }).ok, true);
    assert.equal(readRecentContext({ outputScene: group, now: freshAt + 1 }).length, 1);
    assert.equal(recentContextCounts().length, 1);
    for (let i = 0; i < 70; i += 1) {
      const s = mintTrustedScene({ platform: "qq", kind: "group", id: `bounded-${i}`, verified: true });
      recordTrustedRecentEvent({ eventId: `bounded-${i}`, scene: s, text: "x", at: base + 6000 + i });
    }
    assert.ok(recentContextCounts().length <= 64, "scene map is bounded");
  } finally {
    resetRecentContextForTests();
    resetSceneStateForTests();
  }
});

test("recent context stays directional when scene isolation is off", () => {
  resetSceneStateForTests();
  resetRecentContextForTests();
  configureScene({ enabled: false, strictQQ: false, hostContract: false });
  configureRecentContext({ enabled: true, ttlMs: 600000, maxEvents: 20, maxTokens: 500 });
  const { groupA, groupB, admin } = scenes();
  try {
    const now = Date.now();
    recordTrustedRecentEvent({ eventId: "a", scene: groupA, text: "A 的内容", at: now });
    recordTrustedRecentEvent({ eventId: "b", scene: groupB, text: "B 的秘密", at: now });
    recordTrustedRecentEvent({ eventId: "p", scene: admin, text: "私聊秘密", at: now });
    const seenA = readRecentContext({ outputScene: groupA, now: now + 1 });
    assert.deepEqual(seenA.map((e) => e.text), ["A 的内容"]);
    assert.equal(seenA.some((e) => e.text.includes("B 的秘密")), false);
    assert.equal(seenA.some((e) => e.text.includes("私聊秘密")), false);
    assert.equal(readRecentContext({ outputScene: admin, now: now + 1 }).every((e) => e.scene === admin.sceneId), true,
      "admin private sees only its own private scene; no implicit cross-scene grant");
    assert.equal(readRecentContext({ outputScene: groupB, now: now + 1 }).some((e) => e.text.includes("A 的内容")), false);
  } finally {
    resetRecentContextForTests();
    resetSceneStateForTests();
  }
});

test("Core memories are protected, scene-scoped, persistent and admin-managed", async () => {
  resetSceneStateForTests();
  resetRecentContextForTests();
  configureScene({ enabled: true, strictQQ: true, hostContract: true });
  const { groupA, groupB, admin } = scenes();
  const h = setup("core");
  try {
    assert.throws(() => runWithTrustedScene(groupB, () => h.service.createCore({ title: "x", content: "y" })), /CORE_ADMIN_PRIVATE_REQUIRED/);
    assert.equal(isExplicitCoreRequest("今天天气不错"), false);
    assert.equal(isExplicitCoreRequest("这件事很重要，你一定要永远记住"), true);
    assert.equal(isExplicitCoreRequest("save this as a core memory forever"), true);
    const core = runWithTrustedScene(admin, () => h.service.createCore({
      title: "核心经历", content: "管理员在私聊中说明了重要的事。", core_note: "我会记住。"
    }));
    assert.equal(core.protected, true);
    assert.equal(core.scene_scope, admin.sceneId);
    assert.equal(core.core_note, "我会记住。");

    // Dedupe cannot overwrite a protected row; maintenance cannot forget/archive/delete it.
    const replay = runWithTrustedScene(admin, () => h.service.saveWithDedupe({
      type: "history", title: "核心经历", content: "试图覆盖", importance: 1
    }));
    assert.equal(replay.action, "protected");
    assert.equal(replay.memory.id, core.id);
    assert.equal(h.store.getById(core.id).content, core.content);
    h.store.setForget(core.id, true);
    h.store.setArchived(core.id, true);
    assert.equal(h.store.getById(core.id).forgotten, false);
    assert.equal(h.store.getById(core.id).archived, false);
    assert.equal(h.store.remove(core.id), false);
    assert.equal(h.store.demoteToSummary(core.id, "自动压缩"), undefined);
    assert.equal(h.store.getById(core.id).content, core.content);
    assert.throws(() => h.store.update(core.id, { content: "direct SQL overwrite" }), /PROTECTED_MEMORY/);
    assert.throws(() => runWithTrustedScene(admin, () => h.service.update(core.id, { content: "篡改" })), /PROTECTED_MEMORY/);
    assert.throws(() => runWithTrustedScene(admin, () => h.service.update(core.id, { content: "篡改", _allowProtected: true })), /PROTECTED_MEMORY/);
    runWithTrustedScene(admin, () => h.service.update(core.id, { core_note: "json", protected: false }));
    assert.equal(h.store.getById(core.id).protected, true);
    assert.equal(h.store.getById(core.id).core_note, "我会记住。");

    // Core remains private to its scene; group A cannot see it.
    assert.equal((await runWithTrustedScene(groupA, () => h.service.searchMemories("核心经历"))).length, 0);
    assert.equal((await runWithTrustedScene(admin, () => h.service.searchMemories("核心经历"))).length, 1);
    assert.equal(runWithTrustedScene(admin, () => h.service.listCore()).length, 1);

    const noted = runWithTrustedScene(admin, () => h.service.updateCoreNote(core.id, "更新后的短记"));
    assert.equal(noted.core_note, "更新后的短记");
    const unlocked = runWithTrustedScene(admin, () => h.service.setCoreProtected(core.id, false));
    assert.equal(unlocked.protected, false);
    assert.equal(runWithTrustedScene(admin, () => h.service.setCoreProtected(core.id, true)).protected, true);

    // Persistence across restart.
    h.close();
    const reopened = createStore(join(h.dir, "memory.db"));
    assert.equal(reopened.getById(core.id).protected, true);
    reopened.close();
  } finally {
    h.close();
    h.cleanup();
  }
});

test("strict QQ scene mode closes raw graph API identity surfaces", async () => {
  resetSceneStateForTests();
  configureScene({ enabled: true, strictQQ: true, hostContract: true });
  const routes = [];
  const registrar = createRouteRegistrar({ register(route) { routes.push(route); return () => {}; } }, "", []);
  let called = false;
  registrar.register({
    kind: "get", path: "/api/dsh-mneme/entities", policy: "open",
    handler: () => { called = true; }
  });
  const route = routes[0];
  const res = {
    status: 0, body: "",
    writeHead(status) { this.status = status; },
    end(body) { this.body = String(body ?? ""); }
  };
  await route.handler({ method: "GET", url: "/api/dsh-mneme/entities", headers: {} }, res);
  assert.equal(called, false);
  assert.equal(res.status, 403);
  assert.match(res.body, /scene-isolation-active/);
  resetSceneStateForTests();
});

test("strict QQ scene mode denies direct /list content route (raw list/count fallback)", async () => {
  resetSceneStateForTests();
  configureScene({ enabled: true, strictQQ: true, hostContract: true });
  const { groupB } = scenes();
  const h = setup("list-route");
  try {
    runWithTrustedScene(groupB, () => h.service.saveWithDedupe({
      type: "history", title: "群 B 秘密列表", content: "小雨只属于群 B", importance: 5
    }));
    const routes = [];
    const registrar = createRouteRegistrar({ register(route) { routes.push(route); return () => {}; } }, "", []);
    registrar.register({
      kind: "get", path: "/api/dsh-mneme/list", policy: "open",
      handler: (_req, res) => {
        const body = JSON.stringify(h.service.list({ limit: 50 }));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      }
    });
    const res = {
      status: 0, body: "",
      writeHead(status) { this.status = status; },
      end(body) { this.body = String(body ?? ""); }
    };
    await routes[0].handler({ method: "GET", url: "/api/dsh-mneme/list", headers: {} }, res);
    assert.equal(res.status, 403);
    assert.equal(res.body.includes("小雨"), false);
    assert.match(res.body, /scene-isolation-active/);
  } finally {
    h.close();
    h.cleanup();
    resetSceneStateForTests();
  }
});

test("turning scene flags off does not declassify tagged rows", async () => {
  resetSceneStateForTests();
  configureScene({ enabled: true, strictQQ: true, hostContract: true });
  const { groupA, groupB } = scenes();
  const h = setup("toggle-off");
  try {
    runWithTrustedScene(groupB, () => h.service.saveWithDedupe({
      type: "history", title: "tagged secret", content: "tagged private body", importance: 5
    }));
    h.service.saveWithDedupe({ type: "project", title: "legacy", content: "legacy body" });
    assert.equal(h.store.hasSceneScopedRows(), true);

    configureScene({ enabled: false, strictQQ: false, hostContract: false });
    assert.equal((await h.service.searchMemories("legacy")).length, 1, "legacy rows stay readable");
    assert.equal((await h.service.searchMemories("tagged secret")).length, 0, "tagged rows stay private when flags are off");
    assert.equal((await runWithTrustedScene(groupA, () => h.service.searchMemories("tagged secret"))).length, 0,
      "other scene still cannot read it");

    const routes = [];
    const reg = createRouteRegistrar(
      { register(route) { routes.push(route); return () => {}; } }, "", [],
      { hasSceneScopedRows: () => h.store.hasSceneScopedRows() }
    );
    reg.register({ kind: "get", path: "/api/dsh-mneme/list", policy: "open", handler: (_q, res) => {
      res.writeHead(200); res.end("leak");
    } });
    const res = { status: 0, body: "", writeHead(status) { this.status = status; }, end(body) { this.body = String(body ?? ""); } };
    await routes[0].handler({ method: "GET", url: "/api/dsh-mneme/list", headers: {} }, res);
    assert.equal(res.status, 403);
    assert.equal(res.body.includes("tagged private body"), false);
  } finally {
    h.close(); h.cleanup(); resetSceneStateForTests();
  }
});

test("feature-off preserves legacy behavior and unknown provenance is not public", async () => {
  resetSceneStateForTests();
  configureScene({ enabled: false, strictQQ: false, hostContract: false });
  const h = setup("off");
  try {
    const row = h.service.saveWithDedupe({ type: "project", title: "legacy", content: "ordinary memory" });
    assert.equal(row.memory.scene_scope, undefined);
    assert.equal((await h.service.searchMemories("legacy")).length, 1);
    configureScene({ enabled: true, strictQQ: true, hostContract: true });
    const group = mintTrustedScene({ platform: "qq", kind: "group", id: "group-a", verified: true });
    assert.equal((await runWithTrustedScene(group, () => h.service.searchMemories("legacy"))).length, 0,
      "NULL scene provenance is denied in strict QQ mode");
  } finally {
    h.close();
    h.cleanup();
    resetSceneStateForTests();
  }
});
