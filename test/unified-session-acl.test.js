import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUnifiedSessionAcl, currentUnifiedReadSql, runWithUnifiedSession } from "../src/unified-session-acl.js";
import { createStore } from "../src/store.js";

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
