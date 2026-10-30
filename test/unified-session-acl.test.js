import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUnifiedSessionAcl, currentUnifiedReadSql, runWithUnifiedSession } from "../src/unified-session-acl.js";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createIdentityService } from "../src/identity.js";

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE memories (id TEXT PRIMARY KEY, scene_scope TEXT)");
  const sessions = new Map();
  const scenes = new Map();
  const add = (id, preset = "standard") => {
    const session = { id, header: Object.freeze({ agentPreset: preset }) };
    sessions.set(id, session);
    return session;
  };
  const acl = createUnifiedSessionAcl({
    db, workspaceId: "workspace-1",
    resolveTrustedSession: (id) => sessions.get(id),
    authorizeWorkspace: (session) => ({ allowed: sessions.has(session.id), workspaceId: "workspace-1" }),
    resolveTrustedQQScene: (id) => scenes.get(id) ?? null,
    isTrustedOwner: (session) => session.id === "owner"
  });
  const memory = (id, sceneScope = null) => {
    db.prepare("INSERT INTO memories (id, scene_scope) VALUES (?, ?)").run(id, sceneScope);
    return { id, scene_scope: sceneScope };
  };
  return { db, acl, sessions, scenes, add, memory };
}

test("same preset Sessions remain private; grants are directional and non-transitive", () => {
  const f = fixture();
  const a = f.acl.identify(f.add("a").id);
  const b = f.acl.identify(f.add("b").id);
  const c = f.acl.identify(f.add("c", "bilibili-agent").id);
  const row = f.memory("basketball");
  f.acl.linkMemory(row.id, a);
  assert.equal(f.acl.canReadMemory(a, row), true);
  assert.equal(f.acl.canReadMemory(b, row), false);
  assert.equal(f.acl.canReadMemory(c, row), false);
  f.acl.setGrant(a.sourceKey, b.sourceKey, true);
  assert.equal(f.acl.canReadMemory(b, row), true);
  f.acl.setGrant(b.sourceKey, c.sourceKey, true);
  assert.equal(f.acl.canReadMemory(c, row), false);
  f.acl.setGrant(a.sourceKey, b.sourceKey, false);
  assert.equal(f.acl.canReadMemory(b, row), false);
  assert.equal(f.acl.canReadMemory(a, row), true);
});

test("trusted identities cannot be reused across ACL instances", () => {
  const first = fixture();
  const second = fixture();
  const foreign = first.acl.identify(first.add("a").id);
  second.memory("foreign-row");
  assert.deepEqual([...second.acl.readableSources(foreign)], []);
  assert.equal(second.acl.canReadMemory(foreign, { id: "foreign-row" }), false);
  assert.throws(() => second.acl.linkMemory("foreign-row", foreign), /trusted memory source required/);
});

test("unified writes dedupe within their source and never merge a granted source", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const sessions = new Map(["a", "b"].map((id) => [id, { id, header: { agentPreset: "standard" } }]));
  const acl = createUnifiedSessionAcl({
    db: store.db, workspaceId: "workspace-1",
    resolveTrustedSession: (id) => sessions.get(id),
    authorizeWorkspace: () => ({ allowed: true, workspaceId: "workspace-1" })
  });
  const a = acl.identify("a");
  const b = acl.identify("b");
  const save = (identity, content) => runWithUnifiedSession(acl, identity, () =>
    service.saveWithDedupe({ type: "history", title: "Shared title", content }));
  const first = save(a, "first observation");
  const second = save(a, "second observation");
  assert.equal(second.memory.id, first.memory.id, "one source should retain normal dedupe");
  acl.setGrant(a.sourceKey, b.sourceKey, true);
  const other = save(b, "private second source");
  assert.notEqual(other.memory.id, first.memory.id, "read grant does not authorize a write merge");
  assert.equal(store.count(), 2);
  store.db.close();
});

test("a directional read grant cannot mutate the source memory or attach forged graph evidence", () => {
  const store = createStore(":memory:");
  const sessions = new Map(["a", "b"].map((id) => [id, { id, header: { agentPreset: "standard" } }]));
  const acl = createUnifiedSessionAcl({
    db: store.db, workspaceId: "workspace-1",
    resolveTrustedSession: (id) => sessions.get(id),
    authorizeWorkspace: () => ({ allowed: true, workspaceId: "workspace-1" })
  });
  const a = acl.identify("a");
  const b = acl.identify("b");
  const row = runWithUnifiedSession(acl, a, () => store.save({
    type: "history", title: "A fact", content: "Private source fact"
  }));
  const entity = store.createEntity({ name: "Synthetic Person", type: "person" });
  acl.setGrant(a.sourceKey, b.sourceKey, true);
  runWithUnifiedSession(acl, b, () => {
    assert.equal(store.getById(row.id)?.id, row.id);
    assert.deepEqual(store.recentContents(20), []);
    assert.deepEqual(store.findContentHashMatches({
      type: row.type, hash: row.content_hash
    }), []);
    assert.throws(() => store.update(row.id, { content: "tampered" }), /UNIFIED_WRITE_NOT_OWNED/);
    assert.throws(() => store.compareAndUpdate(row.id, row.updated_at, { content: "tampered" }), /UNIFIED_WRITE_NOT_OWNED/);
    assert.throws(() => store.setForget(row.id, true), /UNIFIED_WRITE_NOT_OWNED/);
    assert.throws(() => store.setArchived(row.id, true), /UNIFIED_WRITE_NOT_OWNED/);
    assert.throws(() => store.remove(row.id), /UNIFIED_WRITE_NOT_OWNED/);
    assert.throws(() => store.saveAttr({ entity_id: entity.id, attr_key: "secret", attr_value: "fake", memory_id: row.id }), /UNIFIED_WRITE_NOT_OWNED/);
    assert.throws(() => store.saveRelation({ from_entity: entity.id, to_entity: entity.id, relation_type: "knows", memory_id: row.id }), /UNIFIED_WRITE_NOT_OWNED/);
  });
  assert.equal(store.getById(row.id)?.content, "Private source fact");
  assert.deepEqual(store.getCurrentAttrs(entity.id), []);
  assert.deepEqual(store.getRelations(entity.id), []);
  store.db.close();
});

test("semantic recall cache cannot carry one Session's memory into another Session's injection", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: { hybridInject: true } });
  const sessions = new Map(["a", "b"].map((id) => [id, { id, header: { agentPreset: "standard" } }]));
  const acl = createUnifiedSessionAcl({
    db: store.db, workspaceId: "workspace-1",
    resolveTrustedSession: (id) => sessions.get(id),
    authorizeWorkspace: () => ({ allowed: true, workspaceId: "workspace-1" })
  });
  const a = acl.identify("a");
  const b = acl.identify("b");
  const row = runWithUnifiedSession(acl, a, () => store.save({
    type: "decision", title: "secret-key", content: "private source", importance: 5
  }));
  const result = await runWithUnifiedSession(acl, a, () => service.searchMemories("secret-key", {
    mode: "keyword", useRerank: false, recordRecall: false
  }));
  assert.equal(result[0]?.id, row.id);
  const injected = runWithUnifiedSession(acl, b, () => service.injectCandidates({
    query: "secret-key", maxItems: 5, threshold: 3
  }));
  assert.equal(injected.some((item) => item.id === row.id), false);
  acl.setGrant(a.sourceKey, b.sourceKey, true);
  const granted = await runWithUnifiedSession(acl, b, () => service.searchMemories("secret-key", {
    mode: "keyword", useRerank: false, recordRecall: false
  }));
  assert.equal(granted[0]?.id, row.id);
  acl.setGrant(a.sourceKey, b.sourceKey, false);
  const revoked = await runWithUnifiedSession(acl, b, () => service.searchMemories("secret-key", {
    mode: "keyword", useRerank: false, recordRecall: false
  }));
  assert.deepEqual(revoked, []);
  store.db.close();
});

test("asynchronous rerank cannot return a result after Host revokes the Session", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  const session = { id: "a", header: { agentPreset: "standard" } };
  let permitted = true;
  const acl = createUnifiedSessionAcl({
    db: store.db, workspaceId: "workspace-1",
    resolveTrustedSession: (id) => permitted && id === "a" ? session : null,
    authorizeWorkspace: () => ({ allowed: true, workspaceId: "workspace-1" })
  });
  const a = acl.identify("a");
  const row = runWithUnifiedSession(acl, a, () => store.save({
    type: "decision", title: "revocation target", content: "private", importance: 5
  }));
  service.setReranker({ rerank: async () => {
    permitted = false;
    return [{ id: row.id, score: 1 }];
  } });
  await assert.rejects(
    runWithUnifiedSession(acl, a, () => service.searchMemories("revocation target", {
      mode: "keyword", useRerank: true, recordRecall: false
    })),
    /UNIFIED_SESSION_INVALID/
  );
  store.db.close();
});

test("existing QQ Scene retains stable identity across Session reconstruction", () => {
  const f = fixture();
  const scene = { platform: "qq", kind: "group", id: "bot1:group9", verified: true };
  f.scenes.set("qq-old", scene);
  f.scenes.set("qq-new", scene);
  const old = f.acl.identify(f.add("qq-old", "amadeus-qq").id);
  const row = f.memory("old-qq-row", "qq:group:bot1:group9");
  assert.equal(f.acl.canReadMemory(old, row), true);
  const replacement = f.acl.identify(f.add("qq-new", "amadeus-qq").id);
  assert.equal(replacement.sourceKey, old.sourceKey);
  assert.equal(f.acl.canReadMemory(replacement, row), true);
  f.scenes.set("qq-old", { ...scene, id: "bot1:other-group" });
  assert.equal(f.acl.identify("qq-old"), null);
});

test("a Host binding or Workspace revocation invalidates an in-flight identity", () => {
  const f = fixture();
  const a = f.acl.identify(f.add("a").id);
  const row = f.memory("live");
  f.acl.linkMemory(row.id, a);
  runWithUnifiedSession(f.acl, a, () => {
    assert.equal(f.acl.canReadMemory(a, row), true);
    f.sessions.delete("a");
    assert.equal(f.acl.canReadMemory(a, row), false);
    assert.throws(() => currentUnifiedReadSql(), /UNIFIED_SESSION_INVALID/);
  });
});

test("unbound QQ, forged identities, legacy rows and mixed source evidence fail closed", () => {
  const f = fixture();
  f.add("unbound", "amadeus-qq-owner");
  assert.equal(f.acl.identify("unbound"), null);
  const a = f.acl.identify(f.add("a").id);
  const b = f.acl.identify(f.add("b").id);
  const row = f.memory("mixed");
  f.acl.linkMemory(row.id, a);
  assert.throws(() => f.acl.linkMemory(row.id, b), /CROSS_SOURCE_MEMORY_MERGE_DENIED/);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS c FROM unified_memory_sources WHERE memory_id = ?")
    .get(row.id).c, 1);
  assert.equal(f.acl.canReadMemory({ ...a }, row), false);
  assert.throws(() => f.acl.linkMemory("forged", { ...a }), /trusted memory source required/);
  const legacy = f.memory("legacy");
  assert.equal(f.acl.canReadMemory(a, legacy), false);
});

test("custom DSH Preset is isolated when QQ Host rejects an unbound Session", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE memories (id TEXT PRIMARY KEY, scene_scope TEXT)");
  const session = { id: "custom-1", header: { agentPreset: "bilibili-agent" } };
  let qqScene = null;
  const acl = createUnifiedSessionAcl({
    db, workspaceId: "workspace-1",
    resolveTrustedSession: (id) => id === session.id ? session : null,
    authorizeWorkspace: () => ({ allowed: true, workspaceId: "workspace-1" }),
    resolveTrustedQQScene: () => {
      if (qqScene) return qqScene;
      throw new Error("unbound");
    }
  });
  const identity = acl.identify(session.id);
  assert.equal(identity.sourceKey, "dsh:session:custom-1");
  const oldQQ = { id: "old", scene_scope: "qq:group:bot1:group9" };
  assert.equal(acl.canReadMemory(identity, oldQQ), false);
  qqScene = { platform: "qq", kind: "group", id: "bot1:group9", verified: true };
  assert.equal(acl.identify(session.id), null, "binding changes require review, not silent inheritance");
});

test("Owner visibility requires a separate policy and Host-verified owner Scene", () => {
  const f = fixture();
  const source = f.acl.identify(f.add("a").id);
  f.scenes.set("owner", { platform: "qq", kind: "private", id: "bot1:owner", verified: true, admin: true });
  const owner = f.acl.identify(f.add("owner", "amadeus-qq-owner").id);
  const row = f.memory("private");
  f.acl.linkMemory(row.id, source);
  assert.equal(f.acl.canReadMemory(owner, row), false);
  f.acl.setOwnerRead(source.sourceKey, true);
  assert.equal(f.acl.canReadMemory(owner, row), true);
  f.acl.setOwnerRead(source.sourceKey, false);
  assert.equal(f.acl.canReadMemory(owner, row), false);
});

test("a preexisting mixed-source row requires grants for every contributor", () => {
  const f = fixture();
  const a = f.acl.identify(f.add("a").id);
  const b = f.acl.identify(f.add("b").id);
  const c = f.acl.identify(f.add("c").id);
  const row = f.memory("mixed-legacy-evidence");
  f.db.prepare("INSERT INTO unified_memory_sources VALUES (?, ?, ?)").run(row.id, a.sourceKey, "2026-01-01");
  f.db.prepare("INSERT INTO unified_memory_sources VALUES (?, ?, ?)").run(row.id, b.sourceKey, "2026-01-01");
  f.acl.setGrant(a.sourceKey, c.sourceKey, true);
  assert.equal(f.acl.canReadMemory(c, row), false);
  f.acl.setGrant(b.sourceKey, c.sourceKey, true);
  assert.equal(f.acl.canReadMemory(c, row), true);
  f.acl.setGrant(a.sourceKey, c.sourceKey, false);
  assert.equal(f.acl.canReadMemory(c, row), false);
});

test("SQL candidate gate filters before LIMIT and tracks immediate revocation", () => {
  const f = fixture();
  const a = f.acl.identify(f.add("a").id);
  const b = f.acl.identify(f.add("b").id);
  const own = f.memory("own");
  const foreign = f.memory("foreign");
  const legacy = f.memory("legacy");
  f.acl.linkMemory(own.id, b);
  f.acl.linkMemory(foreign.id, a);
  const visible = () => runWithUnifiedSession(f.acl, b, () => {
    const clause = currentUnifiedReadSql();
    return f.db.prepare(`SELECT id FROM memories WHERE ${clause.sql} ORDER BY id LIMIT 1`)
      .all(...clause.params).map((row) => row.id);
  });
  assert.deepEqual(visible(), ["own"]);
  f.acl.setGrant(a.sourceKey, b.sourceKey, true);
  assert.deepEqual(visible(), ["foreign"]);
  f.acl.setGrant(a.sourceKey, b.sourceKey, false);
  assert.deepEqual(visible(), ["own"]);
  assert.equal(f.acl.canReadMemory(b, legacy), false);
  assert.throws(() => runWithUnifiedSession(f.acl, { ...b }, () => 1), /trusted unified Session/);
});

test("corrupt Scene stamp cannot disagree with the linked source", () => {
  const f = fixture();
  const a = f.acl.identify(f.add("a").id);
  const row = f.memory("contradictory", "qq:group:bot1:secret");
  f.db.prepare("INSERT INTO unified_memory_sources VALUES (?, ?, ?)").run(row.id, a.sourceKey, "2026-01-01");
  assert.equal(f.acl.canReadMemory(a, row), false);
  const ids = runWithUnifiedSession(f.acl, a, () => {
    const clause = currentUnifiedReadSql();
    return f.db.prepare(`SELECT id FROM memories WHERE ${clause.sql}`).all(...clause.params);
  });
  assert.deepEqual(ids, []);
});

test("schema and policy survive a second opener on the same SQLite database", () => {
  const f = fixture();
  const a = f.acl.identify(f.add("a").id);
  const b = f.acl.identify(f.add("b").id);
  const row = f.memory("persisted");
  f.acl.linkMemory(row.id, a);
  f.acl.setGrant(a.sourceKey, b.sourceKey, true);
  const reopened = createUnifiedSessionAcl({
    db: f.db, workspaceId: "workspace-1",
    resolveTrustedSession: (id) => f.sessions.get(id),
    authorizeWorkspace: () => ({ allowed: true, workspaceId: "workspace-1" }),
    resolveTrustedQQScene: (id) => f.scenes.get(id) ?? null
  });
  assert.equal(reopened.canReadMemory(reopened.identify("b"), row), true);
});

test("grants and source links persist across SQLite close and reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "mneme-unified-acl-"));
  const path = join(dir, "memory.sqlite");
  try {
    const sessions = new Map(["a", "b"].map((id) => [id, { id, header: { agentPreset: "standard" } }]));
    const options = (db) => ({
      db, workspaceId: "workspace-1",
      resolveTrustedSession: (id) => sessions.get(id),
      authorizeWorkspace: () => ({ allowed: true, workspaceId: "workspace-1" })
    });
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE memories (id TEXT PRIMARY KEY, scene_scope TEXT)");
    const first = createUnifiedSessionAcl(options(db));
    const a = first.identify("a");
    const b = first.identify("b");
    db.prepare("INSERT INTO memories VALUES (?, NULL)").run("persistent");
    first.linkMemory("persistent", a);
    first.setGrant(a.sourceKey, b.sourceKey, true);
    db.close();

    const reopened = new DatabaseSync(path);
    const second = createUnifiedSessionAcl(options(reopened));
    assert.equal(second.canReadMemory(second.identify("b"), { id: "persistent" }), true);
    assert.equal(reopened.prepare("PRAGMA quick_check").get().quick_check, "ok");
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("actual Mneme store stamps source atomically and filters list, search, vector before ranking", () => {
  const store = createStore(":memory:");
  const sessions = new Map(["a", "b"].map((id) => [id, { id, header: { agentPreset: "standard" } }]));
  const acl = createUnifiedSessionAcl({
    db: store.db, workspaceId: "workspace-1",
    resolveTrustedSession: (id) => sessions.get(id),
    authorizeWorkspace: () => ({ allowed: true, workspaceId: "workspace-1" })
  });
  const a = acl.identify("a");
  const b = acl.identify("b");
  const save = (identity, title) => runWithUnifiedSession(acl, identity, () => store.save({
    type: "history", title, content: `${title} likes synthetic chess`, embedding: [1, 0]
  }));
  const aRow = save(a, "A private");
  const bRow = save(b, "B private");
  assert.equal(aRow.scene_scope, a.sourceKey);
  assert.equal(bRow.scene_scope, b.sourceKey);
  const inspect = () => runWithUnifiedSession(acl, b, () => ({
    list: store.list({ limit: 1 }).map((row) => row.id),
    search: store.search("synthetic chess", { limit: 1 }).map((row) => row.id),
    vector: store.searchVector([1, 0], { limit: 1 }).map((row) => row.id),
    byId: store.getById(aRow.id),
    graphIds: store.sceneEntityIds(null)
  }));
  const isolated = inspect();
  assert.deepEqual(isolated.list, [bRow.id]);
  assert.deepEqual(isolated.search, [bRow.id]);
  assert.deepEqual(isolated.vector, [bRow.id]);
  assert.equal(isolated.byId, undefined);
  assert.equal(isolated.graphIds.size, 0);
  acl.setGrant(a.sourceKey, b.sourceKey, true);
  assert.equal(runWithUnifiedSession(acl, b, () => store.getById(aRow.id)?.id), aRow.id);
  acl.setGrant(a.sourceKey, b.sourceKey, false);
  assert.equal(runWithUnifiedSession(acl, b, () => store.getById(aRow.id)), undefined);
  assert.equal(store.getById(aRow.id)?.id, aRow.id, "admin store outside model context remains global");
  store.db.close();
});

test("source-link failure rolls back the Mneme memory row", () => {
  const store = createStore(":memory:");
  const session = { id: "a", header: { agentPreset: "standard" } };
  const acl = createUnifiedSessionAcl({
    db: store.db, workspaceId: "workspace-1",
    resolveTrustedSession: () => session,
    authorizeWorkspace: () => ({ allowed: true, workspaceId: "workspace-1" })
  });
  const identity = acl.identify("a");
  store.db.exec("DROP TABLE unified_memory_sources");
  assert.throws(() => runWithUnifiedSession(acl, identity, () => store.save({
    type: "history", title: "should rollback", content: "synthetic"
  })));
  assert.equal(store.count(), 0);
  store.db.close();
});

test("shared global entity exposes only each Session's evidenced attributes and edges", () => {
  const store = createStore(":memory:");
  const sessions = new Map(["a", "b"].map((id) => [id, { id, header: { agentPreset: "standard" } }]));
  const acl = createUnifiedSessionAcl({
    db: store.db, workspaceId: "workspace-1",
    resolveTrustedSession: (id) => sessions.get(id),
    authorizeWorkspace: () => ({ allowed: true, workspaceId: "workspace-1" })
  });
  const a = acl.identify("a");
  const b = acl.identify("b");
  const xiaoming = store.createEntity({ name: "小明", type: "person" });
  const xiaohong = store.createEntity({ name: "小红", type: "person" });
  const xiaowang = store.createEntity({ name: "小王", type: "person" });
  const identityService = createIdentityService({ db: store.db, store });
  identityService.createAlias({ entity_id: xiaoming.id, alias: "秘密绰号", confirmed: true, actor: "owner" });
  const write = (identity, title, key, value, other) => runWithUnifiedSession(acl, identity, () => {
    const memory = store.save({ type: "history", title, content: title });
    store.saveAttr({ entity_id: xiaoming.id, attr_key: key, attr_value: value, memory_id: memory.id });
    store.saveRelation({ from_entity: xiaoming.id, to_entity: other.id,
      relation_type: "knows", memory_id: memory.id });
    return memory;
  });
  const aRow = write(a, "小明喜欢篮球并认识小红", "hobby", "basketball", xiaohong);
  const bRow = write(b, "小明准备换工作并认识小王", "work", "new-job", xiaowang);
  assert.equal(store.list({ limit: 10 }).length, 2, "one global Mneme library remains intact");
  const view = (identity) => runWithUnifiedSession(acl, identity, () => ({
    attrs: store.getCurrentAttrs(xiaoming.id).map((x) => x.attr_key),
    relations: store.getRelations(xiaoming.id).map((x) => x.to_entity),
    neighbors: store.getEntityNeighbors([xiaoming.id]).get(xiaoming.id) ?? [],
    graphNeighbors: identityService.neighborsOf([xiaoming.id]).get(xiaoming.id) ?? [],
    entityIds: store.sceneEntityIds(null),
    names: store.listEntities({ limit: 10 }).map((x) => x.name),
    aliasHit: identityService.findEntitiesMentionedIn("秘密绰号").length,
    privateNameHit: identityService.findEntitiesMentionedIn("小红").length,
    xiaomingGroup: identityService.findEntitiesMentionedIn("小明")[0]?.group,
    linked: [...store.getLinkedMemoryIds([xiaoming.id]).keys()]
  }));
  const aView = view(a);
  assert.deepEqual(aView.attrs, ["hobby"]);
  assert.deepEqual(aView.relations, [xiaohong.id]);
  assert.deepEqual(aView.neighbors, [xiaohong.id]);
  assert.deepEqual(aView.graphNeighbors, [xiaohong.id]);
  assert.equal(aView.entityIds.has(xiaowang.id), false);
  assert.equal(aView.names.includes("小王"), false);
  assert.equal(aView.aliasHit, 0);
  assert.deepEqual(aView.xiaomingGroup.aliases, []);
  assert.equal(aView.xiaomingGroup.mention_count, null);
  assert.equal(aView.xiaomingGroup.last_seen, null);
  assert.deepEqual(aView.linked, [aRow.id]);
  const bView = view(b);
  assert.deepEqual(bView.attrs, ["work"]);
  assert.deepEqual(bView.relations, [xiaowang.id]);
  assert.deepEqual(bView.graphNeighbors, [xiaowang.id]);
  assert.equal(bView.names.includes("小红"), false);
  assert.equal(bView.aliasHit, 0);
  assert.equal(bView.privateNameHit, 0);
  assert.deepEqual(bView.linked, [bRow.id]);
  acl.setGrant(a.sourceKey, b.sourceKey, true);
  assert.deepEqual(new Set(view(b).attrs), new Set(["work", "hobby"]));
  acl.setGrant(a.sourceKey, b.sourceKey, false);
  assert.deepEqual(view(b).attrs, ["work"]);
  assert.equal(store.getById(aRow.id)?.id, aRow.id);
  assert.equal(store.getById(bRow.id)?.id, bRow.id);
  store.db.close();
});

test("an unevidenced global canonical merge is not disclosed to a Session", () => {
  const store = createStore(":memory:");
  const session = { id: "a", header: { agentPreset: "standard" } };
  const acl = createUnifiedSessionAcl({
    db: store.db, workspaceId: "workspace-1",
    resolveTrustedSession: (id) => id === "a" ? session : null,
    authorizeWorkspace: () => ({ allowed: true, workspaceId: "workspace-1" })
  });
  const a = acl.identify("a");
  const first = store.createEntity({ name: "First Person", type: "person" });
  const second = store.createEntity({ name: "Second Person", type: "person" });
  const identity = createIdentityService({ db: store.db, store });
  runWithUnifiedSession(acl, a, () => {
    for (const entity of [first, second]) {
      const row = store.save({ type: "history", title: entity.name, content: `${entity.name} is known` });
      store.saveAttr({ entity_id: entity.id, attr_key: "known", attr_value: "yes", memory_id: row.id });
    }
  });
  store.db.prepare(`INSERT INTO entity_canonical_links
    (id, entity_id, canonical_id, active, source, linked_at)
    VALUES ('test-link', ?, ?, 1, 'manual', '2026-01-01')`).run(first.id, second.id);
  assert.equal(identity.listEntities().length, 1, "admin graph retains the global merge");
  const groups = runWithUnifiedSession(acl, a, () => identity.listEntities());
  assert.equal(groups.length, 2, "a merge without Session evidence is not a model-visible fact");
  assert.equal(groups.every((group) => group.merged === false), true);
  store.db.close();
});
