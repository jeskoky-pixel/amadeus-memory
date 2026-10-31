import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createTools } from "../src/tools.js";
import {
  mintTrustedScene, runWithTrustedScene, configureScene, resetSceneStateForTests,
  setSceneReadAclReader, sceneAllowsMemory, sceneAllowsRecent
} from "../src/scene.js";
import {
  configureRecentContext, recordTrustedRecentEvent, readRecentContext, resetRecentContextForTests
} from "../src/recent-context.js";

const baseConfig = {
  sceneIsolationEnabled: true,
  sceneStrictQQ: true,
  strictScope: true,
  entitySearchEnabled: true,
  autoInject: false,
  autoSummarize: false
};

function scenes() {
  return {
    a: mintTrustedScene({ platform: "qq", kind: "group", id: "bot:group-a", verified: true }),
    b: mintTrustedScene({ platform: "qq", kind: "group", id: "bot:group-b", verified: true }),
    c: mintTrustedScene({ platform: "qq", kind: "group", id: "bot:group-c", verified: true }),
    privateOther: mintTrustedScene({ platform: "qq", kind: "private", id: "bot:peer-x", verified: true }),
    owner: mintTrustedScene({ platform: "qq", kind: "private", id: "bot:owner", verified: true, admin: true })
  };
}

function setup(hostScene) {
  resetSceneStateForTests();
  configureScene({ enabled: true, strictQQ: true, hostContract: true });
  const store = createStore(":memory:");
  setSceneReadAclReader((reader, source) => store.hasSceneReadGrant(reader, source));
  const service = createService({ store, mirror: null, config: baseConfig });
  const registered = [];
  const ctx = {
    tools: { register(def) { registered.push(def); return () => {}; } },
    reflect: { get(name) { return name === "qq" ? { resolveTrustedSessionScene: () => hostScene } : null; } }
  };
  createTools(ctx, service, baseConfig);
  return { store, service, registered, close() { store.close(); } };
}

function execFor(sessionId, preset = "amadeus-qq") {
  return { agent: { session: { id: sessionId, header: { agentPreset: preset } } } };
}

async function seed(service, scene, title, extra = {}) {
  return runWithTrustedScene(scene, () => service.saveWithDedupe({
    type: "history", title, content: `${title} shared body`, importance: 4, ...extra
  }));
}

test("verified owner tool reads all Scenes and honors explicit narrowing", async () => {
  const s = scenes();
  const h = setup(s.owner);
  try {
    await seed(h.service, s.a, "A memory");
    await seed(h.service, s.b, "B memory");
    h.service.saveWithDedupe({ type: "history", title: "legacy memory", content: "legacy shared body", importance: 2 });
    const search = h.registered.find((tool) => tool.name === "memory_search");
    const ownerExec = execFor("owner-session", "amadeus-qq-owner");
    const all = await search.execute({ query: "shared", limit: 20 }, ownerExec);
    assert.deepEqual(all.items.map((item) => item.title).sort(), ["A memory", "B memory", "legacy memory"]);
    const onlyA = await search.execute({ query: "shared", limit: 20, scenes: ["qq:group:bot:group-a"] }, ownerExec);
    assert.deepEqual(onlyA.items.map((item) => item.title), ["A memory"]);
    const multi = await search.execute({ query: "shared", limit: 20, scenes: ["qq:group:bot:group-a", "qq:group:bot:group-b"] }, ownerExec);
    assert.deepEqual(multi.items.map((item) => item.title).sort(), ["A memory", "B memory"]);
    const forged = await search.execute({ query: "shared", limit: 20, scenes: ["qq:group:bot:group-c"], admin: true }, ownerExec);
    assert.deepEqual(forged.items, [], "unknown/ungranted selection cannot broaden or invent data");
  } finally { h.close(); }
});

test("group default reads own Scene, directional grant reads long-term only, no legacy/private", async () => {
  const s = scenes();
  const h = setup(s.a);
  try {
    await seed(h.service, s.a, "A memory", { agent_scope: "group-agent", workspace_scope: "/g/a" });
    await seed(h.service, s.b, "B memory", { agent_scope: "group-agent", workspace_scope: "/g/b" });
    await seed(h.service, s.privateOther, "private memory");
    h.service.saveWithDedupe({ type: "history", title: "legacy memory", content: "legacy shared body" });
    const search = h.registered.find((tool) => tool.name === "memory_search");
    const toolExec = execFor("group-a-session");
    const own = await search.execute({ query: "shared", limit: 20 }, toolExec);
    assert.deepEqual(own.items.map((item) => item.title), ["A memory"]);
    const empty = await search.execute({ query: "shared", limit: 20, scenes: ["qq:group:bot:group-b"] }, toolExec);
    assert.deepEqual(empty.items, [], "ungranted group name must not broaden the read set");

    h.store.grantSceneRead(s.a.sceneId, s.b.sceneId, { actor: "owner:test" });
    const granted = await search.execute({ query: "shared", limit: 20 }, toolExec);
    assert.deepEqual(granted.items.map((item) => item.title).sort(), ["A memory", "B memory"]);
    const explicitB = await search.execute({ query: "shared", limit: 20, scenes: ["qq:group:bot:group-b"] }, toolExec);
    assert.deepEqual(explicitB.items.map((item) => item.title), ["B memory"]);
    assert.equal(granted.items.some((item) => item.title === "private memory" || item.title === "legacy memory"), false);
    assert.equal(sceneAllowsMemory(s.a, s.privateOther.sceneId), false);
    assert.equal(sceneAllowsMemory(s.a, null), false);
  } finally { h.close(); }
});

test("owner tool reads group memories despite different agent/workspace labels; groups stay filtered", async () => {
  const owner = scenes().owner;
  const h = setup(owner);
  try {
    const group = scenes().a;
    await seed(h.service, group, "group-labelled", { agent_scope: "other-agent", workspace_scope: "/other/ws" });
    const list = h.registered.find((tool) => tool.name === "memory_list");
    const ownerRes = await list.execute({ limit: 20 }, execFor("owner-session", "amadeus-qq-owner"));
    assert.ok(ownerRes.items.some((item) => item.title === "group-labelled"), "owner strictScope exception must see group labels");
  } finally { h.close(); }
});

test("grant never widens raw Recent Context; owner capability still reads all Recent", () => {
  const s = scenes();
  resetRecentContextForTests();
  configureScene({ enabled: true, strictQQ: true, hostContract: true });
  configureRecentContext({ enabled: true, ttlMs: 600000, maxEvents: 20, maxTokens: 500 });
  const now = Date.now();
  recordTrustedRecentEvent({ eventId: "b1", scene: s.b, text: "B raw transcript", at: now });
  assert.equal(sceneAllowsRecent(s.a, s.b.sceneId), false);
  assert.equal(readRecentContext({ outputScene: s.a, now }).length, 0);
  assert.equal(readRecentContext({ outputScene: s.owner, now }).length, 1);
  resetRecentContextForTests();
  resetSceneStateForTests();
});

test("missing Host binding fails tool execution closed", async () => {
  const h = setup(undefined);
  try {
    const search = h.registered.find((tool) => tool.name === "memory_search");
    await assert.rejects(
      search.execute({ query: "x" }, execFor("missing-session")),
      /SCENE_UNVERIFIED|QQ_HOST_UNAVAILABLE/
    );
  } finally { h.close(); }
});

test("custom QQ Preset without Host binding cannot read or write unscoped memory", async () => {
  const h = setup(undefined);
  try {
    const exec = execFor("custom-qq-session", "renamed-qq-preset");
    const search = h.registered.find((tool) => tool.name === "memory_search");
    const save = h.registered.find((tool) => tool.name === "memory_save");
    await assert.rejects(search.execute({ query: "secret" }, exec), /SCENE_UNVERIFIED/);
    await assert.rejects(save.execute({ title: "secret", content: "private" }, exec), /SCENE_UNVERIFIED/);
    assert.equal(h.store.count(), 0);
  } finally { h.close(); }
});

test("ordinary DSH tools can read and update their unscoped memories in strict QQ mode", async () => {
  const h = setup(undefined);
  try {
    const ordinary = execFor("ordinary-session", "standard");
    const save = h.registered.find((tool) => tool.name === "memory_save");
    const search = h.registered.find((tool) => tool.name === "memory_search");
    const list = h.registered.find((tool) => tool.name === "memory_list");
    const get = h.registered.find((tool) => tool.name === "memory_get");
    const update = h.registered.find((tool) => tool.name === "memory_update");
    const own = await save.execute({ type: "project", title: "blue crane", content: "lighthouse seven" }, ordinary);
    assert.equal(own.action, "created");
    assert.equal(h.store.getById(own.id).scene_scope ?? null, null);
    await seed(h.service, scenes().a, "QQ secret blue crane");
    assert.deepEqual((await search.execute({ query: "blue crane", mode: "keyword" }, ordinary)).items.map((m) => m.id), [own.id]);
    assert.deepEqual((await list.execute({ limit: 20 }, ordinary)).items.map((m) => m.id), [own.id]);
    assert.equal((await get.execute({ id: own.id }, ordinary)).memory.id, own.id);
    const secondSession = execFor("other-ordinary-session", "standard");
    assert.deepEqual((await search.execute({ query: "blue crane", mode: "keyword" }, secondSession)).items.map((m) => m.id), [own.id]);
    await update.execute({ id: own.id, content: "lighthouse eight" }, ordinary);
    assert.equal((await get.execute({ id: own.id }, ordinary)).memory.content, "lighthouse eight");
  } finally { h.close(); }
});

test("disallowed high-rank candidates do not starve valid Scene recall", async () => {
  const s = scenes();
  const h = setup(s.a);
  try {
    for (let i = 0; i < 40; i += 1) {
      await seed(h.service, s.c, `C forbidden ${i}`, { importance: 5 });
    }
    await seed(h.service, s.a, "A allowed forbidden", { importance: 1 });
    const search = h.registered.find((tool) => tool.name === "memory_search");
    const result = await search.execute({ query: "forbidden", limit: 1, mode: "keyword" }, execFor("group-a-session"));
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].title, "A allowed forbidden", "allowed-row top-K must be filled after Scene filtering");
  } finally { h.close(); }
});

test("owner memory_get reads group row despite strictScope labels; mutations stay Scene-bound", async () => {
  const all = scenes();
  const h = setup(all.owner);
  try {
    const group = all.a;
    const saved = await seed(h.service, group, "owner get group", { agent_scope: "group-agent", workspace_scope: "/group" });
    const get = h.registered.find((tool) => tool.name === "memory_get");
    const got = await get.execute({ id: saved.memory.id }, execFor("owner-session", "amadeus-qq-owner"));
    assert.equal(got.memory.id, saved.memory.id, "owner read must bypass strictScope agent/workspace labels");
    const update = h.registered.find((tool) => tool.name === "memory_update");
    await assert.rejects(
      update.execute({ id: saved.memory.id, title: "owner write attempt" }, execFor("owner-session", "amadeus-qq-owner")),
      /memory not found|SCENE_DENIED/
    );
    assert.equal(h.store.getById(saved.memory.id).title, "owner get group");
  } finally { h.close(); }
});

test("memory_list scans past disallowed rows and keeps page semantics", async () => {
  const s = scenes();
  const h = setup(s.a);
  try {
    for (let i = 0; i < 30; i += 1) await seed(h.service, s.c, `C list ${i}`, { importance: 5 });
    await seed(h.service, s.a, "A list visible", { importance: 1 });
    const list = h.registered.find((tool) => tool.name === "memory_list");
    const page = await list.execute({ limit: 1, offset: 0 }, execFor("group-a-session"));
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].title, "A list visible");
  } finally { h.close(); }
});

test("owner cross-group delete/archive are denied; own private writes still work", async () => {
  const s = scenes();
  const h = setup(s.owner);
  try {
    const group = await seed(h.service, s.a, "group protected row");
    const ownerExec = execFor("owner-session", "amadeus-qq-owner");
    const archive = h.registered.find((tool) => tool.name === "memory_archive");
    const del = h.registered.find((tool) => tool.name === "memory_delete");
    await assert.rejects(archive.execute({ id: group.memory.id, archived: true }, ownerExec), /memory not found/);
    assert.equal((await del.execute({ id: group.memory.id }, ownerExec)).deleted, false);
    assert.equal(h.store.getById(group.memory.id).archived, false);
    assert.ok(h.store.getById(group.memory.id));

    const save = h.registered.find((tool) => tool.name === "memory_save");
    const own = await save.execute({ type: "history", title: "owner private", content: "owner body" }, ownerExec);
    assert.equal(own.action, "created");
    assert.equal(h.store.getById(own.id).scene_scope, s.owner.sceneId);
    assert.equal((await archive.execute({ id: own.id, archived: true }, ownerExec)).memory.archived, true);
  } finally { h.close(); }
});

test("legacy rows are owner-readable but not model-mutable in strict Scene", async () => {
  const s = scenes();
  const h = setup(s.owner);
  try {
    const legacy = h.service.saveWithDedupe({ type: "history", title: "legacy row", content: "legacy body" });
    const ownerExec = execFor("owner-session", "amadeus-qq-owner");
    const get = h.registered.find((tool) => tool.name === "memory_get");
    assert.equal((await get.execute({ id: legacy.memory.id }, ownerExec)).memory.id, legacy.memory.id);
    const archive = h.registered.find((tool) => tool.name === "memory_archive");
    const del = h.registered.find((tool) => tool.name === "memory_delete");
    await assert.rejects(archive.execute({ id: legacy.memory.id, archived: true }, ownerExec), /memory not found/);
    assert.equal((await del.execute({ id: legacy.memory.id }, ownerExec)).deleted, false);
    assert.equal(h.store.getById(legacy.memory.id).archived, false);
    assert.ok(h.store.getById(legacy.memory.id));
  } finally { h.close(); }
});

test("Scene read ACL survives process restart and is idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "amadeus-acl-"));
  const file = join(dir, "memory.db");
  try {
    const first = createStore(file);
    first.grantSceneRead("qq:group:bot:a", "qq:group:bot:b", { actor: "owner:test" });
    first.grantSceneRead("qq:group:bot:a", "qq:group:bot:b", { actor: "owner:test" });
    assert.equal(first.listSceneReadGrants().length, 1, "unique reader/source pair");
    first.close();

    const second = createStore(file);
    assert.equal(second.hasSceneReadGrant("qq:group:bot:a", "qq:group:bot:b"), true);
    assert.equal(second.hasSceneReadGrant("qq:group:bot:b", "qq:group:bot:a"), false);
    assert.equal(second.revokeSceneRead("qq:group:bot:a", "qq:group:bot:b").revoked, true);
    second.close();

    const third = createStore(file);
    assert.equal(third.hasSceneReadGrant("qq:group:bot:a", "qq:group:bot:b"), false);
    third.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("model list reaches an allowed group row beyond a thousand unrelated rows", async () => {
  const s = scenes();
  const h = setup(s.a);
  try {
    for (let i = 0; i < 1005; i += 1) {
      h.store.save({ type: "history", title: `unrelated ${i}`, content: "unrelated", importance: 5, scene_scope: s.c.sceneId });
    }
    await seed(h.service, s.a, "allowed beyond window", { importance: 1 });
    const list = h.registered.find((tool) => tool.name === "memory_list");
    const page = await list.execute({ limit: 1, offset: 0 }, execFor("group-a-session"));
    assert.equal(page.items[0]?.title, "allowed beyond window");
    assert.equal(page.total, 1);
    assert.equal(page.truncated, false);
  } finally { h.close(); }
});

test("keyword recall reaches an allowed group row beyond the unrelated candidate pool", async () => {
  const s = scenes();
  const h = setup(s.a);
  try {
    for (let i = 0; i < 220; i += 1) {
      h.store.save({ type: "history", title: `forbidden ${i}`, content: "forbidden", importance: 5, scene_scope: s.c.sceneId });
    }
    await seed(h.service, s.a, "allowed forbidden tail", { importance: 1 });
    const search = h.registered.find((tool) => tool.name === "memory_search");
    const result = await search.execute({ query: "forbidden", limit: 1, mode: "keyword" }, execFor("group-a-session"));
    assert.equal(result.items[0]?.title, "allowed forbidden tail");
  } finally { h.close(); }
});

test("memory_list preserves nonempty offsets after SQL Scene filtering", async () => {
  const s = scenes();
  const h = setup(s.a);
  try {
    for (let i = 0; i < 40; i += 1) await seed(h.service, s.c, `offset forbidden ${i}`, { importance: 5 });
    await seed(h.service, s.a, "offset allowed one", { importance: 1 });
    await seed(h.service, s.a, "offset allowed two", { importance: 1 });
    const list = h.registered.find((tool) => tool.name === "memory_list");
    const page = await list.execute({ limit: 1, offset: 1 }, execFor("group-a-session"));
    assert.equal(page.total, 2);
    assert.equal(page.truncated, false);
    assert.equal(["offset allowed one", "offset allowed two"].includes(page.items[0]?.title), true);
  } finally { h.close(); }
});

test("granted group remains readable when 500+ other Scenes outrank it", async () => {
  const s = scenes();
  const target = mintTrustedScene({ platform: "qq", kind: "group", id: "bot:zzzz-target", verified: true });
  const h = setup(s.a);
  try {
    for (let i = 0; i < 501; i += 1) {
      h.store.save({
        type: "history",
        title: `outranking ${i}`,
        content: "unrelated synthetic body",
        importance: 5,
        scene_scope: `qq:group:bot:a-${String(i).padStart(3, "0")}`
      });
    }
    h.store.grantSceneRead(s.a.sceneId, target.sceneId, { actor: "owner:test" });
    await seed(h.service, target, "low volume allowed target", { importance: 1 });
    assert.equal(h.store.listSceneScopes().some((row) => row.scope === target.sceneId), false,
      "fixture must push target beyond the store's top-500 Scene enumeration");
    const list = h.registered.find((tool) => tool.name === "memory_list");
    const page = await list.execute({ limit: 1, offset: 0 }, execFor("group-a-session"));
    assert.equal(page.items[0]?.title, "low volume allowed target");
    assert.equal(page.total, 1);
    const rawSearch = h.store.search;
    let keywordScopes;
    h.store.search = (query, options) => { keywordScopes = options?.sceneScopes; return rawSearch(query, options); };
    const search = h.registered.find((tool) => tool.name === "memory_search");
    const found = await search.execute({ query: "low volume allowed target", limit: 1, mode: "keyword" }, execFor("group-a-session"));
    assert.equal(found.items[0]?.title, "low volume allowed target", "search must use the persisted grant, not top-500 Scene counts");
    assert.ok(keywordScopes?.includes(target.sceneId), "keyword SQL must be filtered by the persisted grant");
    const injected = await runWithTrustedScene(s.a, () => h.service.searchMemories("low volume allowed target", {
      mode: "keyword", topK: 1, recordRecall: false
    }));
    assert.equal(injected[0]?.title, "low volume allowed target", "automatic injection must use the same persisted grants as tools");
  } finally { h.close(); }
});
