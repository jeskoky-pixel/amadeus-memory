// Stable identity / aliases / reversible canonicalization (Amadeus memory
// enhancer). Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { extractEntities } from "../src/entities/extractor.js";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "mneme-identity-"));
}

function makeService(config = {}) {
  const dir = tmpDir();
  const store = createStore(join(dir, "memory.db"));
  const service = createService({ store, mirror: null, config, logger: null });
  return {
    dir,
    store,
    service,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function addEntity(service, name, type = "person") {
  const result = service.identity.resolveEntityForWrite({ name, type, actor: "test" });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.entity;
}

test("legacy organization-typed QQ groups migrate safely without merging", () => {
  const dir = tmpDir();
  const dbPath = join(dir, "legacy-qq-org.db");
  const old = new DatabaseSync(dbPath);
  old.exec(`
    CREATE TABLE entities (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT,
      first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
      mention_count INTEGER DEFAULT 1, canonical_memory_id TEXT
    );
    CREATE TABLE entity_attrs (
      id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, attr_key TEXT NOT NULL,
      attr_value TEXT NOT NULL, memory_id TEXT, valid_from TEXT NOT NULL,
      valid_until TEXT, confidence REAL DEFAULT 1.0, source TEXT
    );
    CREATE TABLE entity_relations (
      id TEXT PRIMARY KEY, from_entity TEXT NOT NULL, to_entity TEXT NOT NULL,
      relation_type TEXT NOT NULL, memory_id TEXT, created_at TEXT NOT NULL,
      metadata TEXT, weight REAL NOT NULL DEFAULT 0.4, source TEXT NOT NULL DEFAULT 'llm'
    );
  `);
  const now = new Date().toISOString();
  const insEntity = old.prepare("INSERT INTO entities VALUES (?,?,?,?,?,?,?)");
  insEntity.run("g1", "QQ群90003001", "organization", now, now, 4, null);
  insEntity.run("g2", "QQ 群 90003001", "organization", now, now, 2, null);
  insEntity.run("g3", "群90003002", "organization", now, now, 1, null);
  insEntity.run("g4", "QQ群90003003", "person", now, now, 1, null);
  old.prepare("INSERT INTO entity_attrs VALUES (?,?,?,?,?,?,?,?,?)")
    .run("a1", "g1", "kind", "old group metadata", "m1", now, null, 0.8, "llm_extract");
  old.prepare("INSERT INTO entity_relations VALUES (?,?,?,?,?,?,?,?,?)")
    .run("r1", "g1", "g3", "related_to", "m1", now, "{}", 0.4, "llm");
  old.close();

  const store = createStore(dbPath);
  const service = createService({ store, mirror: null, config: {} });
  assert.equal(store.findEntityById("g1").type, "group");
  assert.equal(store.findEntityById("g2").type, "group");
  assert.equal(store.findEntityById("g3").type, "group");
  assert.equal(store.findEntityById("g4").type, "person", "person/group boundary is preserved");
  const g1External = service.identity.listExternalIds({ entity_id: "g1" });
  const g2External = service.identity.listExternalIds({ entity_id: "g2" });
  const g3External = service.identity.listExternalIds({ entity_id: "g3" });
  const g4External = service.identity.listExternalIds({ entity_id: "g4" });
  assert.equal(g1External.length + g2External.length, 1, "one owner for the duplicated numeric id");
  assert.equal(g3External[0].external_id, "90003002");
  assert.equal(g4External.length, 0);
  const g1Payload = g1External[0] ? g1External[0].evidence : null;
  assert.equal(g1Payload?.previous_type, "organization");
  const events = store.db.prepare(
    "SELECT event_type, payload FROM identity_audit_events WHERE event_type LIKE 'legacy_qq_group_%'"
  ).all().map((row) => ({ type: row.event_type, payload: JSON.parse(row.payload) }));
  assert.ok(events.some((event) => event.type === "legacy_qq_group_identity" && event.payload.previous_type === "organization"));
  assert.ok(events.some((event) => event.type === "legacy_qq_group_duplicate" && event.payload.previous_type === "organization"));
  assert.equal(service.identity.listLinks().length, 0, "migration never auto-links");
  assert.equal(store.getAttrsByMemory("m1").length, 1);
  assert.equal(store.getRelations("g1")[0].weight, 0.4);

  const candidates = service.identity.findDuplicateCandidates({ minScore: 0.72 });
  assert.ok(candidates.some((pair) =>
    [pair.left.id, pair.right.id].includes("g1") && [pair.left.id, pair.right.id].includes("g2")
  ), "duplicate QQ groups remain visible as manual candidates");
  const report = service.identity.dryRunMerge({ from_entity: "g1", to_entity: "g2", actor: "test" });
  assert.equal(report.blocked, false);
  const before = {
    attrs: store.db.prepare("SELECT COUNT(*) AS c FROM entity_attrs").get().c,
    relations: store.db.prepare("SELECT COUNT(*) AS c FROM entity_relations").get().c
  };
  service.identity.confirmMerge({ report_id: report.report_id, actor: "test" });
  assert.equal(service.identity.canonicalIdOf("g1"), "g2");
  assert.equal(store.findEntityById("g1").id, "g1");
  assert.deepEqual({
    attrs: store.db.prepare("SELECT COUNT(*) AS c FROM entity_attrs").get().c,
    relations: store.db.prepare("SELECT COUNT(*) AS c FROM entity_relations").get().c
  }, before);
  store.close();

  const reopened = createStore(dbPath);
  const svc2 = createService({ store: reopened, mirror: null, config: {} });
  const duplicateAudits = reopened.db.prepare(
    "SELECT COUNT(*) AS c FROM identity_audit_events WHERE event_type = 'legacy_qq_group_duplicate'"
  ).get().c;
  assert.equal(duplicateAudits, 1, "duplicate migration audit is idempotent");
  assert.equal(svc2.identity.listExternalIds({ entity_id: "g2", include_revoked: true }).length, 1);
  reopened.close();
  rmSync(dir, { recursive: true, force: true });
});

test("legacy schema migration keeps entity/attr/relation rows and seeds unconfirmed labels", () => {
  const dir = tmpDir();
  const dbPath = join(dir, "legacy.db");
  const old = new DatabaseSync(dbPath);
  old.exec(`
    CREATE TABLE entities (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT,
      first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
      mention_count INTEGER DEFAULT 1, canonical_memory_id TEXT
    );
    CREATE TABLE entity_attrs (
      id TEXT PRIMARY KEY, entity_id TEXT NOT NULL, attr_key TEXT NOT NULL,
      attr_value TEXT NOT NULL, memory_id TEXT, valid_from TEXT NOT NULL,
      valid_until TEXT, confidence REAL DEFAULT 1.0, source TEXT
    );
    CREATE TABLE entity_relations (
      id TEXT PRIMARY KEY, from_entity TEXT NOT NULL, to_entity TEXT NOT NULL,
      relation_type TEXT NOT NULL, memory_id TEXT, created_at TEXT NOT NULL,
      metadata TEXT, weight REAL NOT NULL DEFAULT 0.4, source TEXT NOT NULL DEFAULT 'llm'
    );
  `);
  const now = new Date().toISOString();
  old.prepare("INSERT INTO entities VALUES (?,?,?,?,?,?,?)").run("e1", "QQ群90000001", null, now, now, 3, null);
  old.prepare("INSERT INTO entities VALUES (?,?,?,?,?,?,?)").run("e2", "Aster", "person", now, now, 1, null);
  old.prepare("INSERT INTO entity_attrs VALUES (?,?,?,?,?,?,?,?,?)")
    .run("a1", "e2", "role", "engineer", "m1", now, null, 0.8, "llm_extract");
  old.prepare("INSERT INTO entity_relations VALUES (?,?,?,?,?,?,?,?,?)")
    .run("r1", "e2", "e2", "related_to", "m1", now, "{}", 0.4, "llm");
  old.close();

  const store = createStore(dbPath);
  const service = createService({ store, mirror: null, config: {} });
  assert.equal(store.findEntityById("e1").name, "QQ群90000001");
  assert.equal(store.findEntityById("e1").type, "group");
  assert.equal(store.getAttrsByMemory("m1").length, 1);
  const rel = store.getRelations("e2")[0];
  assert.equal(rel.weight, 0.4);
  assert.equal(rel.source, "llm");
  const aliases = service.identity.listAliases({ entity_id: "e2" });
  assert.equal(aliases.length, 1);
  assert.equal(aliases[0].confirmed, false);
  assert.equal(aliases[0].provenance, "legacy_name");
  const external = service.identity.listExternalIds({ entity_id: "e1" });
  assert.equal(external.length, 1);
  assert.equal(external[0].external_id, "90000001");
  assert.equal(external[0].entity_type, "group");
  // Repeat open: no duplicate seed rows.
  store.close();
  const reopened = createStore(dbPath);
  const svc2 = createService({ store: reopened, mirror: null, config: {} });
  assert.equal(svc2.identity.listAliases({ entity_id: "e2" }).length, 1);
  reopened.close();
  rmSync(dir, { recursive: true, force: true });
});

test("external id + alias resolution keeps one stable UUID; edit/unlink/history are auditable", () => {
  const h = makeService();
  try {
    const qq = addEntity(h.service, "QQ群90000002", "group");
    const linked = h.service.identity.linkExternalId({
      entity_id: qq.id,
      platform: "qq",
      entity_type: "group",
      external_id: "90000002",
      actor: "tester",
      evidence: [{ kind: "test", value: "synthetic" }]
    });
    assert.equal(linked.external_id, "90000002");
    // Name resolution and typed-id resolution both land on the same UUID.
    assert.equal(h.service.identity.resolveEntityForWrite({
      name: "QQ 群 90000002", type: "group", actor: "test"
    }).entity.id, qq.id);
    const byName = h.service.findEntityGroup("QQ群90000002");
    assert.equal(byName.groups.length, 1);
    assert.equal(byName.groups[0].id, qq.id);

    const alias = h.service.identity.createAlias({
      entity_id: qq.id, alias: "周末群", actor: "tester", confirmed: false
    });
    assert.equal(h.service.identity.confirmAlias({ id: alias.id, actor: "tester" }).confirmed, true);
    assert.equal(h.service.identity.resolveForSearch("周末群").groups[0].id, qq.id);
    assert.equal(h.service.identity.resolveForSearch("90000002").groups[0].id, qq.id);
    const edited = h.service.identity.updateAlias({ id: alias.id, alias: "周末闲聊群", actor: "tester" });
    assert.equal(edited.alias, "周末闲聊群");
    const history = h.service.identity.history({ entity_id: qq.id });
    assert.ok(history.aliases.length >= 3);
    assert.ok(history.aliases.some((row) => row.active === false && row.alias === "周末群"));
    assert.ok(history.aliases.some((row) => row.active === true && row.alias === "QQ 群 90000002"),
      "an observed spelling is recorded as an unconfirmed alias, not a merge");
    assert.ok(history.events.some((row) => row.event_type === "alias_edit"));
    assert.ok(history.events.some((row) => row.event_type === "external_id_add"));
    assert.throws(
      () => h.store.db.prepare("UPDATE identity_audit_events SET actor = 'rewrite'").run(),
      /append-only/
    );
    assert.throws(
      () => h.store.db.prepare("DELETE FROM identity_audit_events").run(),
      /append-only/
    );
    h.service.identity.unlinkAlias({ id: edited.id, actor: "tester" });
    assert.equal(h.service.identity.resolveForSearch("周末闲聊群").groups.length, 0);
    // The external identifier still resolves the entity until it is unlinked.
    assert.equal(h.service.identity.resolveForSearch("90000002").groups.length, 1);
    h.service.identity.unlinkExternalId({ id: linked.id, actor: "tester" });
    assert.equal(h.service.identity.resolveForSearch("90000002").groups.length, 0);
    assert.equal(h.service.identity.listExternalIds({ entity_id: qq.id }).length, 0);
    assert.equal(h.service.identity.listExternalIds({ entity_id: qq.id, include_revoked: true }).length, 1);
  } finally {
    h.close();
  }
});

test("two people sharing a name stay separate; extraction returns candidates instead of guessing", async () => {
  const h = makeService();
  try {
    // Duplicate names predate the resolver (or arrive through an explicit
    // import); they stay separate records and are never merged by name.
    const one = h.store.createEntity({ name: "Robin", type: "person" });
    const two = h.store.createEntity({ name: "Robin", type: "person" });
    assert.notEqual(one.id, two.id);
    const resolution = h.service.identity.resolveEntityForWrite({ name: "Robin", type: "person", actor: "test" });
    assert.equal(resolution.ok, false);
    assert.equal(resolution.reason, "ambiguous-entity");
    assert.equal(resolution.candidates.length, 2);
    const candidates = h.service.identity.findDuplicateCandidates({ minScore: 0.72 });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].reasons.includes("same-name"), true);
    assert.equal(candidates[0].requires_confirmation, true);

    const memory = h.service.saveWithDedupe({
      type: "history", title: "Robin chat", content: "Robin said hello", importance: 3
    }).memory;
    const extracted = await extractEntities(
      { id: memory.id, content: "Robin said hello" },
      {
        store: h.store,
        config: {},
        identity: h.service.identity,
        callLLM: async () => JSON.stringify({
          entities: [{ name: "Robin", type: "person", attrs: [{ key: "mood", value: "happy" }] }],
          relations: []
        })
      }
    );
    assert.equal(extracted.ok, true);
    assert.equal(extracted.entities.length, 0);
    assert.equal(extracted.unresolved.length, 1);
    assert.equal(extracted.unresolved[0].reason, "ambiguous-entity");
    assert.equal(h.store.getAttrsByMemory(memory.id).length, 0);
    assert.equal(h.service.identity.listLinks().length, 0, "similarity must never link automatically");
  } finally {
    h.close();
  }
});

test("two people sharing a nickname produce candidates and a confirmation conflict", () => {
  const h = makeService();
  try {
    const one = h.store.createEntity({ name: "Robin One", type: "person" });
    const two = h.store.createEntity({ name: "Robin Two", type: "person" });
    const a = h.service.identity.createAlias({ entity_id: one.id, alias: "Birdie", actor: "test" });
    h.service.identity.createAlias({ entity_id: two.id, alias: "Birdie", actor: "test" });
    h.service.identity.confirmAlias({ id: a.id, actor: "test" });
    const b = h.service.identity.listAliases({ entity_id: two.id })[0];
    assert.throws(
      () => h.service.identity.confirmAlias({ id: b.id, actor: "test" }),
      (error) => error.code === "alias-conflict"
    );
    // The shared nickname is a candidate signal, never an automatic merge.
    assert.equal(h.service.identity.canonicalIdOf(one.id), one.id);
    assert.equal(h.service.identity.canonicalIdOf(two.id), two.id);
    const candidates = h.service.identity.findDuplicateCandidates({ minScore: 0.72 });
    assert.ok(candidates.some((pair) => pair.reasons.includes("shared-alias")));
  } finally {
    h.close();
  }
});

test("different stable ids on one platform never share a nickname identity", () => {
  const h = makeService();
  try {
    const a = h.service.identity.resolveEntityForWrite({
      name: "Twin", type: "person", platform: "qq", external_id: "11111111"
    });
    const b = h.service.identity.resolveEntityForWrite({
      name: "Twin", type: "person", platform: "qq", external_id: "22222222"
    });
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.notEqual(a.entity.id, b.entity.id);
    assert.equal(b.matched_by, "new_external_id");
    assert.equal(h.service.identity.listExternalIds({ entity_id: a.entity.id })[0].external_id, "11111111");
    assert.equal(h.service.identity.listExternalIds({ entity_id: b.entity.id })[0].external_id, "22222222");
    // Same id with a different nickname resolves the same UUID and records the
    // new spelling as an unconfirmed observed alias.
    const again = h.service.identity.resolveEntityForWrite({
      name: "Twin B", type: "person", platform: "qq", external_id: "11111111"
    });
    assert.equal(again.ok, true);
    assert.equal(again.entity.id, a.entity.id);
    assert.ok(h.service.identity.listAliases({ entity_id: a.entity.id }).some((row) => row.alias === "Twin B"));
  } finally {
    h.close();
  }
});

test("name-only person resolution never reuses an unconfirmed name", () => {
  const h = makeService();
  try {
    const first = h.service.identity.resolveEntityForWrite({ name: "Twin", type: "person" });
    assert.equal(first.ok, true);
    const second = h.service.identity.resolveEntityForWrite({ name: "Twin", type: "person" });
    assert.equal(second.ok, false);
    assert.equal(second.reason, "name-only-unresolved");
    assert.equal(second.candidates.length, 1);
    assert.equal(second.candidates[0].id, first.entity.id);
    // Explicit human confirmation turns the label into a safe binding.
    const alias = h.service.identity.listAliases({ entity_id: first.entity.id })[0];
    h.service.identity.confirmAlias({ id: alias.id, actor: "test" });
    const third = h.service.identity.resolveEntityForWrite({ name: "Twin", type: "person" });
    assert.equal(third.ok, true);
    assert.equal(third.entity.id, first.entity.id);
    assert.equal(third.matched_by, "confirmed_alias");
  } finally {
    h.close();
  }
});

test("cross-platform ids stay separate by default but can be explicitly linked", () => {
  const h = makeService();
  try {
    const qq = h.service.identity.resolveEntityForWrite({
      name: "Twin", type: "person", platform: "qq", external_id: "33333333"
    });
    const tg = h.service.identity.resolveEntityForWrite({
      name: "Twin", type: "person", platform: "telegram", external_id: "33333333"
    });
    assert.notEqual(qq.entity.id, tg.entity.id);
    const report = h.service.identity.dryRunMerge({
      from_entity: tg.entity.id, to_entity: qq.entity.id, actor: "human"
    });
    assert.equal(report.blocked, false, "cross-platform stable ids are not a hard blocker");
    const merged = h.service.identity.confirmMerge({ report_id: report.report_id, actor: "human" });
    assert.equal(merged.canonical.member_ids.length, 2);
    // Person <-> group remains a hard barrier even after a dry run.
    const group = h.service.identity.resolveEntityForWrite({
      name: "QQ群90000009", type: "group", platform: "qq", external_id: "90000009"
    });
    const blocked = h.service.identity.dryRunMerge({
      from_entity: group.entity.id, to_entity: qq.entity.id, actor: "human"
    });
    assert.equal(blocked.blocked, true);
    assert.ok(blocked.blockers.some((b) => b.code === "type-boundary"));
  } finally {
    h.close();
  }
});

test("same numeric id under different entity types creates separate identities", () => {
  const h = makeService();
  try {
    const group = h.service.identity.resolveEntityForWrite({
      name: "QQ群12345", type: "group", platform: "qq", external_id: "12345"
    });
    const person = h.service.identity.resolveEntityForWrite({
      name: "Twin", type: "person", platform: "qq", external_id: "12345"
    });
    assert.equal(group.ok, true);
    assert.equal(person.ok, true);
    assert.notEqual(group.entity.id, person.entity.id);
    assert.equal(group.entity.type, "group");
    assert.equal(person.entity.type, "person");
    const groupExt = h.service.identity.listExternalIds({ entity_id: group.entity.id });
    const personExt = h.service.identity.listExternalIds({ entity_id: person.entity.id });
    assert.equal(groupExt[0].entity_type, "group");
    assert.equal(personExt[0].entity_type, "person");
    assert.equal(groupExt[0].external_id, "12345");
    assert.equal(personExt[0].external_id, "12345");
    // The typed external IDs stay authoritative within their own triplet.
    const groupAgain = h.service.identity.resolveEntityForWrite({
      name: "Renamed group", type: "group", platform: "qq", external_id: "12345"
    });
    const personAgain = h.service.identity.resolveEntityForWrite({
      name: "Renamed person", type: "person", platform: "qq", external_id: "12345"
    });
    assert.equal(groupAgain.entity.id, group.entity.id);
    assert.equal(personAgain.entity.id, person.entity.id);
    // Person/group cannot be canonicalized together.
    const report = h.service.identity.dryRunMerge({
      from_entity: person.entity.id, to_entity: group.entity.id, actor: "test"
    });
    assert.equal(report.blocked, true);
    assert.ok(report.blockers.some((blocker) => blocker.code === "type-boundary"));
  } finally {
    h.close();
  }
});

test("normalised QQ group variants resolve the same typed id", () => {
  const h = makeService();
  try {
    const first = h.service.identity.resolveEntityForWrite({ name: "QQ群90000011", type: "group" });
    const second = h.service.identity.resolveEntityForWrite({ name: "QQ 群 90000011", type: "group" });
    const third = h.service.identity.resolveEntityForWrite({ name: "群90000011", type: "group" });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(third.ok, true);
    assert.equal(second.entity.id, first.entity.id);
    assert.equal(third.entity.id, first.entity.id);
  } finally {
    h.close();
  }
});

test("type and platform boundaries are strict; different stable ids cannot merge", () => {
  const h = makeService();
  try {
    const group = addEntity(h.service, "QQ群90000003", "group");
    const person = addEntity(h.service, "Sky", "person");
    h.service.identity.linkExternalId({
      entity_id: group.id, platform: "qq", entity_type: "group", external_id: "90000003", actor: "test"
    });
    assert.throws(
      () => h.service.identity.linkExternalId({
        entity_id: person.id, platform: "qq", entity_type: "group", external_id: "90000003", actor: "test"
      }),
      (error) => error.code === "type-boundary" || error.code === "external-id-conflict"
    );
    // Same digits on a different platform is a different identifier.
    const tel = h.service.identity.linkExternalId({
      entity_id: person.id, platform: "telegram", entity_type: "person", external_id: "90000003", actor: "test"
    });
    assert.equal(tel.platform, "telegram");
    // Same name but different types never resolves into the other type.
    const other = h.store.createEntity({ name: "Sky", type: "concept" });
    const mismatch = h.service.identity.resolveEntityForWrite({ name: "Sky", type: "person", actor: "test" });
    assert.equal(mismatch.ok, false);
    assert.ok(["ambiguous-entity", "type-boundary"].includes(mismatch.reason));

    const otherGroup = addEntity(h.service, "QQ群90000004", "group");
    h.service.identity.linkExternalId({
      entity_id: otherGroup.id, platform: "qq", entity_type: "group", external_id: "90000004", actor: "test"
    });
    const report = h.service.identity.dryRunMerge({
      from_entity: group.id, to_entity: otherGroup.id, actor: "test"
    });
    assert.equal(report.blocked, true);
    assert.ok(report.blockers.some((b) => b.code === "conflicting-stable-ids"));
    assert.throws(
      () => h.service.identity.confirmMerge({ report_id: report.report_id, actor: "test" }),
      (error) => error.code === "merge-blocked"
    );
    // Person <-> group is blocked even without external ids.
    const personReport = h.service.identity.dryRunMerge({
      from_entity: other.id, to_entity: person.id, actor: "test"
    });
    assert.ok(personReport.blockers.some((b) => b.code === "type-boundary"));
  } finally {
    h.close();
  }
});

test("bounded similar-name blocking still proposes close names", () => {
  const h = makeService();
  try {
    const one = h.store.createEntity({ name: "Aster", type: "person" });
    const two = h.store.createEntity({ name: "Astor", type: "person" });
    const candidates = h.service.identity.findDuplicateCandidates({ minScore: 0.72 });
    assert.ok(candidates.some((pair) =>
      [pair.left.id, pair.right.id].includes(one.id) && [pair.left.id, pair.right.id].includes(two.id)
    ));
    assert.equal(h.service.identity.lastSnapshotStats().queries, 4);
  } finally {
    h.close();
  }
});

test("thousands of entities use one indexed snapshot and blocking candidates", () => {
  const h = makeService();
  try {
    h.store.db.exec("BEGIN");
    for (let i = 0; i < 3000; i++) {
      h.store.createEntity({ name: `Entity ${String(i).padStart(4, "0")}`, type: "person" });
    }
    h.store.db.exec("COMMIT");
    const list = h.service.listEntities({ limit: 1000000 });
    assert.equal(list.length, 3000, "the default directory read must not hide entities behind a low cap");
    const stats = h.service.identity.lastSnapshotStats();
    assert.equal(stats.queries, 4, "one request must batch entities/links/aliases/external ids");
    assert.equal(stats.entities, 3000);

    const canonical = h.store.createEntity({ name: "QQ群90002001", type: "group" });
    const variant = h.store.createEntity({ name: "QQ 群 90002001", type: "group" });
    const candidates = h.service.identity.findDuplicateCandidates({ limit: 20, minScore: 0.72 });
    assert.ok(candidates.some((pair) =>
      [pair.left.id, pair.right.id].includes(canonical.id) &&
      [pair.left.id, pair.right.id].includes(variant.id)
    ), "normalized QQ group variants must be found by the typed-id block");
    assert.equal(h.service.identity.lastSnapshotStats().queries, 4);
  } finally {
    h.close();
  }
});

test("merge report fingerprint rejects same-count attr/relation/identity changes", () => {
  const h = makeService();
  try {
    const left = h.store.createEntity({ name: "Aster", type: "person" });
    const right = h.store.createEntity({ name: "Aster", type: "person" });
    const memory = h.service.saveWithDedupe({
      type: "history", title: "Synthetic merge fingerprint", content: "synthetic", importance: 3
    }).memory;
    const attr = h.store.saveAttr({
      entity_id: left.id, attr_key: "city", attr_value: "Turku", memory_id: memory.id, source: "test"
    });
    const relation = h.store.saveRelation({
      from_entity: left.id, to_entity: right.id, relation_type: "related_to",
      memory_id: memory.id, source: "test", weight: 0.5
    });
    const preview = () => h.service.identity.dryRunMerge({
      from_entity: left.id, to_entity: right.id, actor: "test"
    });
    const firstReport = preview();
    h.store.db.prepare("UPDATE entity_attrs SET attr_value = ? WHERE id = ?").run("Helsinki", attr.id);
    assert.throws(
      () => h.service.identity.confirmMerge({ report_id: firstReport.report_id, actor: "test" }),
      (error) => error.code === "stale-report"
    );

    const secondReport = preview();
    h.store.db.prepare("UPDATE entity_relations SET weight = ?, source = ? WHERE id = ?").run(0.9, "manual", relation.id);
    assert.throws(
      () => h.service.identity.confirmMerge({ report_id: secondReport.report_id, actor: "test" }),
      (error) => error.code === "stale-report"
    );

    const thirdReport = preview();
    h.service.identity.linkExternalId({
      entity_id: right.id, platform: "telegram", entity_type: "person",
      external_id: "synthetic-777", actor: "test"
    });
    assert.throws(
      () => h.service.identity.confirmMerge({ report_id: thirdReport.report_id, actor: "test" }),
      (error) => error.code === "stale-report"
    );

    const finalReport = preview();
    const merged = h.service.identity.confirmMerge({ report_id: finalReport.report_id, actor: "test" });
    assert.equal(merged.link.active, true);
    assert.throws(
      () => h.service.identity.confirmMerge({ report_id: finalReport.report_id, actor: "test" }),
      (error) => error.code === "report-applied"
    );
    h.service.identity.undoMerge({ report_id: finalReport.report_id, actor: "test" });
    assert.throws(
      () => h.service.identity.confirmMerge({ report_id: finalReport.report_id, actor: "test" }),
      (error) => error.code === "report-undone"
    );
  } finally {
    h.close();
  }
});

test("canonical merge is reversible and never rewrites memories, attrs or relations", () => {
  const h = makeService();
  try {
    const left = h.store.createEntity({ name: "Aster", type: "person" });
    const right = h.store.createEntity({ name: "Aster", type: "person" });
    const memA = h.service.saveWithDedupe({
      type: "history", title: "Aster likes tea", content: "Aster likes tea", importance: 3
    }).memory;
    const memB = h.service.saveWithDedupe({
      type: "history", title: "Aster moved", content: "Aster moved to Helsinki", importance: 4
    }).memory;
    h.store.saveAttr({ entity_id: left.id, attr_key: "city", attr_value: "Turku", memory_id: memA.id, source: "test" });
    h.store.saveAttr({ entity_id: right.id, attr_key: "city", attr_value: "Helsinki", memory_id: memB.id, source: "test" });
    h.store.saveRelation({
      from_entity: left.id, to_entity: right.id, relation_type: "related_to", memory_id: memA.id, source: "test", weight: 0.7
    });
    const before = {
      entities: h.store.listEntities({ limit: 100 }).length,
      attrs: h.store.db.prepare("SELECT COUNT(*) AS c FROM entity_attrs").get().c,
      relations: h.store.db.prepare("SELECT COUNT(*) AS c FROM entity_relations").get().c,
      memories: h.store.db.prepare("SELECT COUNT(*) AS c FROM memories").get().c
    };
    const report = h.service.identity.dryRunMerge({ from_entity: left.id, to_entity: right.id, actor: "test" });
    assert.equal(report.blocked, false);
    assert.equal(report.counts.attrs_linked, 1);
    assert.equal(report.counts.relations_linked, 1);
    assert.equal(report.counts.attr_conflicts, 1);
    const merged = h.service.identity.confirmMerge({ report_id: report.report_id, actor: "test" });
    assert.equal(merged.canonical.member_ids.length, 2);
    assert.equal(h.service.identity.canonicalIdOf(left.id), right.id);
    assert.equal(h.service.listEntities({ limit: 100 }).filter((g) => g.member_ids.includes(left.id)).length, 1);
    const relationView = h.service.getRelations(right.id);
    assert.equal(relationView.length, 0, "relation internal to the merged group is hidden in the view");
    assert.equal(h.service.entitiesForMemory(memA.id)[0].id, right.id);
    const searched = awaitable(h.service.searchByEntity("Aster"));
    assert.equal(searched.length, 2);
    assert.equal(searched.every((row) => row._canonical_id === right.id), true);
    // Underlying rows are untouched.
    const after = {
      entities: h.store.listEntities({ limit: 100 }).length,
      attrs: h.store.db.prepare("SELECT COUNT(*) AS c FROM entity_attrs").get().c,
      relations: h.store.db.prepare("SELECT COUNT(*) AS c FROM entity_relations").get().c,
      memories: h.store.db.prepare("SELECT COUNT(*) AS c FROM memories").get().c
    };
    assert.deepEqual(after, before);
    assert.equal(h.store.getAttrHistory(left.id).length, 1);
    assert.equal(h.store.getRelations(left.id)[0].weight, 0.7);

    const undone = h.service.identity.undoMerge({ report_id: report.report_id, actor: "test" });
    assert.equal(undone.link.active, false);
    assert.equal(h.service.identity.canonicalIdOf(left.id), left.id);
    const independent = awaitable(h.service.searchByEntity("Aster"));
    assert.equal(independent.length, 2);
    const leftHits = awaitable(h.service.searchByEntity(left.id));
    assert.equal(leftHits.some((row) => row._source === "entity_attr" && row._canonical_id === left.id), true);
    const rightHits = awaitable(h.service.searchByEntity(right.id));
    assert.equal(rightHits.some((row) => row._source === "entity_attr" && row._canonical_id === right.id), true);
  } finally {
    h.close();
  }
});

function awaitable(value) {
  // searchByEntity is synchronous; this keeps the test readable without
  // pretending it is async.
  return value;
}
