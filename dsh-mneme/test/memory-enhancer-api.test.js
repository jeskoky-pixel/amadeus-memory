// API surface for stable identity, aliases, merge dry-run/undo and preferences.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSettings } from "../src/settings.js";
import { createApi, ROUTE_POLICIES } from "../src/api.js";

class FakeRes extends EventEmitter {
  constructor() { super(); this.statusCode = 200; this.body = ""; }
  writeHead(code, headers) { this.statusCode = code; this.headers = headers; return this; }
  end(text) { this.body = text ?? ""; this.emit("end"); return this; }
}
function req(method, url, body = null, headers = {}) {
  const r = new EventEmitter();
  r.method = method;
  r.url = url;
  r.headers = headers;
  if (body !== null) {
    const text = JSON.stringify(body);
    process.nextTick(() => { r.emit("data", Buffer.from(text)); r.emit("end"); });
  } else {
    process.nextTick(() => r.emit("end"));
  }
  return r;
}
function setup(config = {}, token = "secret-token") {
  const dir = mkdtempSync(join(tmpdir(), "mneme-enhancer-api-"));
  const store = createStore(join(dir, "memory.db"));
  const service = createService({ store, mirror: null, config });
  const routes = [];
  const api = createApi(
    { webServer: { register(route) { routes.push(route); return () => {}; } } },
    service, createSettings(store.db), { add() {}, remove() {}, list: () => [] },
    null, undefined, token, config
  );
  const route = (path) => routes.find((r) => r.path === path);
  return {
    dir, store, service, routes, api, route, token,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
const auth = { authorization: "Bearer secret-token" };

test("all enhancer routes declare a policy and are mounted", () => {
  const h = setup();
  try {
    for (const path of [
      "/api/dsh-mneme/identity/aliases",
      "/api/dsh-mneme/identity/external-ids",
      "/api/dsh-mneme/identity/candidates",
      "/api/dsh-mneme/identity/merge-preview",
      "/api/dsh-mneme/identity/merge",
      "/api/dsh-mneme/identity/merge-undo",
      "/api/dsh-mneme/identity/links",
      "/api/dsh-mneme/identity/history",
      "/api/dsh-mneme/identity/entity-detail",
      "/api/dsh-mneme/identity/pending",
      "/api/dsh-mneme/preferences",
      "/api/dsh-mneme/intake"
    ]) {
      const route = h.route(path);
      assert.ok(route, `${path} is not mounted`);
      assert.ok(ROUTE_POLICIES.includes(route.policy), `${path} has no valid policy`);
    }
    assert.equal(h.api.routes, h.routes.length);
  } finally {
    h.close();
  }
});

test("duplicate names require an explicit UUID in graph reads", async () => {
  const h = setup();
  try {
    const one = h.store.createEntity({ name: "Robin", type: "person" });
    const two = h.store.createEntity({ name: "Robin", type: "person" });
    const ego = h.route("/api/dsh-mneme/semantic/graph/ego");
    const ambiguous = new FakeRes();
    await ego.handler(req("GET", "/api/dsh-mneme/semantic/graph/ego?entity=Robin"), ambiguous);
    assert.equal(ambiguous.statusCode, 409);
    assert.equal(JSON.parse(ambiguous.body).error, "ambiguous-entity");
    const byId = new FakeRes();
    await ego.handler(req("GET", `/api/dsh-mneme/semantic/graph/ego?id=${one.id}`), byId);
    assert.equal(byId.statusCode, 200);
    assert.equal(JSON.parse(byId.body).root.id, one.id);
    const directory = new FakeRes();
    await h.route("/api/dsh-mneme/entities").handler(req("GET", "/api/dsh-mneme/entities?limit=10"), directory);
    assert.equal(directory.statusCode, 200);
    const list = JSON.parse(directory.body).entities;
    assert.equal(list.filter((g) => g.name === "Robin").length, 2);
    assert.equal(list.every((g) => !("member_ids" in g) && !("aliases" in g) && !("external_ids" in g)), true,
      "legacy open /entities must not disclose new identity fields");
    assert.ok(list.every((g) => typeof g.id === "string" && typeof g.name === "string"));
  } finally {
    h.close();
  }
});

test("entity directory pages past 1000 with a true total and legacy redacted shape", async () => {
  const h = setup();
  try {
    h.store.db.exec("BEGIN");
    for (let i = 0; i < 1205; i++) {
      h.store.createEntity({ name: `Synthetic entity ${String(i).padStart(4, "0")}`, type: "person" });
    }
    h.store.db.exec("COMMIT");
    const route = h.route("/api/dsh-mneme/entities");
    const first = new FakeRes();
    await route.handler(req("GET", "/api/dsh-mneme/entities?limit=1000&offset=0"), first);
    assert.equal(first.statusCode, 200);
    const firstBody = JSON.parse(first.body);
    assert.equal(firstBody.total, 1205);
    assert.equal(firstBody.entities.length, 1000);
    assert.equal(firstBody.has_more, true);
    assert.equal(firstBody.offset, 0);
    assert.equal(firstBody.entities.every((row) =>
      !("aliases" in row) && !("external_ids" in row) && !("member_ids" in row)
    ), true);
    const second = new FakeRes();
    await route.handler(req("GET", "/api/dsh-mneme/entities?limit=1000&offset=1000"), second);
    const secondBody = JSON.parse(second.body);
    assert.equal(secondBody.total, 1205);
    assert.equal(secondBody.entities.length, 205);
    assert.equal(secondBody.has_more, false);
    const ids = new Set([...firstBody.entities, ...secondBody.entities].map((row) => row.id));
    assert.equal(ids.size, 1205, "every entity is reachable through bounded pages");
    const search = new FakeRes();
    await route.handler(req("GET", "/api/dsh-mneme/entities?limit=1000&q=Synthetic%20entity%2000"), search);
    const searchBody = JSON.parse(search.body);
    assert.equal(searchBody.total, 100);
    assert.equal(searchBody.has_more, false);
  } finally {
    h.close();
  }
});

test("trusted intake request_id replays idempotently and conflicts with 409", async () => {
  const h = setup({ trustedIntakeEnabled: true });
  try {
    const payload = {
      kind: "self_action",
      status: "completed",
      participation: "agent",
      trust_source: "system",
      actor: "life-api-test",
      title: "Synthetic idempotent experience",
      content: "Life completed a synthetic idempotent experience.",
      scope: { agent_scope: "amadeus", workspace_scope: "life-test" },
      request_id: "synthetic-request-1",
      evidence: [{ kind: "receipt", value: "synthetic-r1" }]
    };
    const first = new FakeRes();
    await h.route("/api/dsh-mneme/intake").handler(
      req("POST", "/api/dsh-mneme/intake", payload, auth), first
    );
    assert.equal(first.statusCode, 200);
    const firstBody = JSON.parse(first.body);
    const replay = new FakeRes();
    await h.route("/api/dsh-mneme/intake").handler(
      req("POST", "/api/dsh-mneme/intake", payload, auth), replay
    );
    assert.equal(replay.statusCode, 200);
    const replayBody = JSON.parse(replay.body);
    assert.equal(replayBody.memory.id, firstBody.memory.id);
    assert.equal(replayBody.provenance.id, firstBody.provenance.id);
    assert.equal(replayBody.replayed, true);
    const conflict = new FakeRes();
    await h.route("/api/dsh-mneme/intake").handler(
      req("POST", "/api/dsh-mneme/intake", { ...payload, content: "Different synthetic content." }, auth), conflict
    );
    assert.equal(conflict.statusCode, 409);
    assert.equal(JSON.parse(conflict.body).error, "request-id-conflict");
  } finally {
    h.close();
  }
});

test("alias and external-id routes require auth and expose history", async () => {
  const h = setup();
  try {
    const entity = h.store.createEntity({ name: "Aster", type: "person" });
    const aliases = h.route("/api/dsh-mneme/identity/aliases");
    const denied = new FakeRes();
    await aliases.handler(req("POST", "/api/dsh-mneme/identity/aliases", {
      action: "create", entity_id: entity.id, alias: "Aster Two", confirmed: true
    }), denied);
    assert.equal(denied.statusCode, 401);

    const created = new FakeRes();
    await aliases.handler(req("POST", "/api/dsh-mneme/identity/aliases", {
      action: "create", entity_id: entity.id, alias: "Aster Two", confirmed: true, actor: "panel"
    }, auth), created);
    assert.equal(created.statusCode, 200);
    const alias = JSON.parse(created.body).alias;
    assert.equal(alias.confirmed, true);

    const ext = h.route("/api/dsh-mneme/identity/external-ids");
    const linked = new FakeRes();
    await ext.handler(req("POST", "/api/dsh-mneme/identity/external-ids", {
      entity_id: entity.id, platform: "telegram", entity_type: "person", external_id: "synthetic-100"
    }, auth), linked);
    assert.equal(linked.statusCode, 200);
    assert.equal(JSON.parse(linked.body).external_id.external_id, "synthetic-100");

    const history = new FakeRes();
    await h.route("/api/dsh-mneme/identity/history").handler(
      req("GET", `/api/dsh-mneme/identity/history?entity_id=${entity.id}`, null, auth), history
    );
    assert.equal(history.statusCode, 200);
    const body = JSON.parse(history.body);
    assert.equal(body.aliases.length >= 1, true);
    assert.equal(body.aliases.some((row) => row.alias === "Aster Two"), true);
    assert.ok(body.events.some((event) => event.event_type === "external_id_add"));

    const unlink = new FakeRes();
    await aliases.handler(req("POST", "/api/dsh-mneme/identity/aliases", {
      action: "unlink", id: alias.id, actor: "panel"
    }, auth), unlink);
    assert.equal(unlink.statusCode, 200);
    assert.equal(JSON.parse(unlink.body).alias.active, false);
  } finally {
    h.close();
  }
});

test("merge-preview/merge/undo API keeps originals and restores the independent view", async () => {
  const h = setup();
  try {
    const left = h.store.createEntity({ name: "Aster", type: "person" });
    const right = h.store.createEntity({ name: "Aster", type: "person" });
    const memory = h.service.saveWithDedupe({
      type: "history", title: "Aster note", content: "Aster note", importance: 3
    }).memory;
    h.store.saveAttr({ entity_id: left.id, attr_key: "city", attr_value: "Turku", memory_id: memory.id, source: "test" });
    const previewRoute = h.route("/api/dsh-mneme/identity/merge-preview");
    const preview = new FakeRes();
    await previewRoute.handler(req("POST", "/api/dsh-mneme/identity/merge-preview", {
      from_entity: left.id, to_entity: right.id, actor: "panel"
    }, auth), preview);
    assert.equal(preview.statusCode, 200);
    const report = JSON.parse(preview.body);
    assert.equal(report.counts.attrs_linked, 1);
    const merge = new FakeRes();
    await h.route("/api/dsh-mneme/identity/merge").handler(req("POST", "/api/dsh-mneme/identity/merge", {
      report_id: report.report_id, actor: "panel"
    }, auth), merge);
    assert.equal(merge.statusCode, 200);
    assert.equal(h.service.identity.canonicalIdOf(left.id), right.id);
    assert.equal(h.store.findEntityById(left.id).id, left.id, "original entity UUID preserved");
    assert.equal(h.store.getAttrHistory(left.id).length, 1, "attr history preserved");
    const undo = new FakeRes();
    await h.route("/api/dsh-mneme/identity/merge-undo").handler(req("POST", "/api/dsh-mneme/identity/merge-undo", {
      report_id: report.report_id, actor: "panel"
    }, auth), undo);
    assert.equal(undo.statusCode, 200);
    assert.equal(h.service.identity.canonicalIdOf(left.id), left.id);
    // Reusing an already-undone report is refused.
    const again = new FakeRes();
    await h.route("/api/dsh-mneme/identity/merge").handler(req("POST", "/api/dsh-mneme/identity/merge", {
      report_id: report.report_id, actor: "panel"
    }, auth), again);
    assert.equal(again.statusCode, 409);
  } finally {
    h.close();
  }
});

test("search route forwards the bounded preference explanation", async () => {
  const h = setup({ memoryPreferenceEnabled: true });
  try {
    h.service.setTagWeight({ tag: "close", weight: 1.5, actor: "test" });
    h.service.saveWithDedupe({
      type: "history", title: "synthetic budget note", content: "budget review",
      importance: 3, tags: ["close"]
    });
    const res = new FakeRes();
    await h.route("/api/dsh-mneme/search").handler(
      req("GET", "/api/dsh-mneme/search?q=budget&mode=keyword&limit=5"), res
    );
    assert.equal(res.statusCode, 200);
    const items = JSON.parse(res.body).items;
    assert.ok(items.length > 0);
    assert.ok(items[0].preference);
    assert.ok(items[0].preference.factor >= 0.6 && items[0].preference.factor <= 1.6);
    assert.equal(items[0].preference.applied, true);
  } finally {
    h.close();
  }
});

test("new identity/provenance routes fail closed when no server token is configured", async () => {
  const h = setup({}, "");
  try {
    const entity = h.store.createEntity({ name: "Aster", type: "person" });
    const cases = [
      ["/api/dsh-mneme/identity/aliases", `?entity_id=${entity.id}`],
      ["/api/dsh-mneme/identity/external-ids", `?entity_id=${entity.id}`],
      ["/api/dsh-mneme/identity/candidates", ""],
      ["/api/dsh-mneme/identity/links", ""],
      ["/api/dsh-mneme/identity/history", `?entity_id=${entity.id}`],
      ["/api/dsh-mneme/identity/entity-detail", `?id=${entity.id}`],
      ["/api/dsh-mneme/identity/pending", ""],
      ["/api/dsh-mneme/preferences", ""],
      ["/api/dsh-mneme/intake/provenance", "?memoryId=synthetic"],
      ["/api/dsh-mneme/identity/merge-preview", ""]
    ];
    for (const [path, suffix] of cases) {
      const res = new FakeRes();
      const method = path.endsWith("merge-preview") ? "POST" : "GET";
      await h.route(path).handler(req(method, path + suffix, method === "POST" ? {} : null), res);
      assert.equal(res.statusCode, 503, `${path} must fail closed without apiToken`);
      assert.equal(JSON.parse(res.body).error, "api-token-required");
    }
    // Legacy open reads remain available, but only with their legacy shape.
    const directory = new FakeRes();
    await h.route("/api/dsh-mneme/entities").handler(req("GET", "/api/dsh-mneme/entities"), directory);
    assert.equal(directory.statusCode, 200);
  } finally {
    h.close();
  }
});

test("configured token still rejects unauthenticated reads of new sensitive routes", async () => {
  const h = setup();
  try {
    const entity = h.store.createEntity({ name: "Aster", type: "person" });
    const cases = [
      ["/api/dsh-mneme/identity/aliases", `?entity_id=${entity.id}`],
      ["/api/dsh-mneme/identity/external-ids", `?entity_id=${entity.id}`],
      ["/api/dsh-mneme/identity/candidates", ""],
      ["/api/dsh-mneme/identity/links", ""],
      ["/api/dsh-mneme/identity/history", `?entity_id=${entity.id}`],
      ["/api/dsh-mneme/identity/entity-detail", `?id=${entity.id}`],
      ["/api/dsh-mneme/identity/pending", ""],
      ["/api/dsh-mneme/preferences", ""],
      ["/api/dsh-mneme/intake/provenance", "?memoryId=synthetic"]
    ];
    for (const [path, suffix] of cases) {
      const res = new FakeRes();
      await h.route(path).handler(req("GET", path + suffix), res);
      assert.equal(res.statusCode, 401, `${path} must require the configured token`);
    }
  } finally {
    h.close();
  }
});

test("legacy open graph reads are redacted; authenticated detail carries provenance", async () => {
  const h = setup({ entitySearchEnabled: true, entityRecallEnabled: true });
  try {
    const entity = h.store.createEntity({ name: "Aster", type: "person" });
    const other = h.store.createEntity({ name: "Group", type: "group" });
    h.service.identity.createAlias({ entity_id: entity.id, alias: "Secret Bird", confirmed: true, actor: "test" });
    h.service.identity.linkExternalId({
      entity_id: entity.id, platform: "qq", entity_type: "person",
      external_id: "synthetic-private-id", actor: "test"
    });
    const memory = h.service.saveWithDedupe({
      type: "history", title: "Synthetic graph redaction", content: "synthetic", importance: 3
    }).memory;
    h.store.saveAttr({ entity_id: entity.id, attr_key: "city", attr_value: "Turku", memory_id: memory.id, source: "test" });
    h.store.saveRelation({
      from_entity: entity.id, to_entity: other.id, relation_type: "related_to",
      memory_id: memory.id, source: "test", weight: 0.7
    });
    const ego = new FakeRes();
    await h.route("/api/dsh-mneme/semantic/graph/ego").handler(
      req("GET", `/api/dsh-mneme/semantic/graph/ego?id=${entity.id}`), ego
    );
    assert.equal(ego.statusCode, 200);
    const egoBody = JSON.parse(ego.body);
    assert.equal("aliases" in egoBody.root, false);
    assert.equal("external_ids" in egoBody.root, false);
    assert.equal(egoBody.nodes.every((node) => !("member_ids" in node) && !("aliases" in node)), true);
    assert.equal(egoBody.edges.every((edge) => !("weight" in edge) && !("source" in edge) && !("edge_ids" in edge)), true);

    // Public name lookup still works, but a secret alias/external ID must not be
    // a probing oracle on the open directory or graph routes.
    const byName = new FakeRes();
    await h.route("/api/dsh-mneme/semantic/graph/ego").handler(
      req("GET", `/api/dsh-mneme/semantic/graph/ego?entity=${encodeURIComponent("Aster")}`), byName
    );
    assert.equal(byName.statusCode, 200);
    for (const probe of ["Secret Bird", "synthetic-private-id"]) {
      const graphProbe = new FakeRes();
      await h.route("/api/dsh-mneme/semantic/graph/ego").handler(
        req("GET", `/api/dsh-mneme/semantic/graph/ego?entity=${encodeURIComponent(probe)}`), graphProbe
      );
      assert.equal(graphProbe.statusCode, 404, `ego must not resolve private alias/id ${probe}`);
      const attrProbe = new FakeRes();
      await h.route("/api/dsh-mneme/semantic/graph/entity-attrs").handler(
        req("GET", `/api/dsh-mneme/semantic/graph/entity-attrs?entity=${encodeURIComponent(probe)}`), attrProbe
      );
      assert.equal(attrProbe.statusCode, 404, `entity-attrs must not resolve private alias/id ${probe}`);
      const dirProbe = new FakeRes();
      await h.route("/api/dsh-mneme/entities").handler(
        req("GET", `/api/dsh-mneme/entities?q=${encodeURIComponent(probe)}`), dirProbe
      );
      assert.equal(JSON.parse(dirProbe.body).total, 0, `directory q must not match private alias/id ${probe}`);
    }
    const publicDir = new FakeRes();
    await h.route("/api/dsh-mneme/entities").handler(
      req("GET", `/api/dsh-mneme/entities?q=Aster`), publicDir
    );
    assert.equal(JSON.parse(publicDir.body).total, 1, "public display-name search still works");
    const privateEntitySearch = new FakeRes();
    await h.route("/api/dsh-mneme/search").handler(
      req("GET", `/api/dsh-mneme/search?q=${encodeURIComponent("entity:Secret Bird")}&limit=5`), privateEntitySearch
    );
    assert.equal(JSON.parse(privateEntitySearch.body).items.length, 0,
      "open /search entity: prefix must not resolve a private alias");
    const publicEntitySearch = new FakeRes();
    await h.route("/api/dsh-mneme/search").handler(
      req("GET", `/api/dsh-mneme/search?q=${encodeURIComponent("entity:" + entity.id)}&limit=5`), publicEntitySearch
    );
    assert.ok(JSON.parse(publicEntitySearch.body).items.length > 0,
      "UUID entity: search remains functional for the panel");

    // Ordinary open search graph recall must not use a private alias as a seed.
    const internalGraphRecall = await h.service.searchMemories("Secret Bird", {
      mode: "auto", topK: 5, recordRecall: false
    });
    assert.ok(internalGraphRecall.some((row) => row.id === memory.id),
      "internal/model retrieval keeps full alias graph recall");
    const openGraphRecall = new FakeRes();
    await h.route("/api/dsh-mneme/search").handler(
      req("GET", `/api/dsh-mneme/search?q=${encodeURIComponent("Secret Bird")}&limit=5`), openGraphRecall
    );
    assert.equal(JSON.parse(openGraphRecall.body).items.some((row) => row.id === memory.id), false,
      "open ordinary search must not disclose a graph-linked memory through a private alias");
    const publicGraphRecall = new FakeRes();
    await h.route("/api/dsh-mneme/search").handler(
      req("GET", `/api/dsh-mneme/search?q=${encodeURIComponent("Aster")}&limit=5`), publicGraphRecall
    );
    assert.equal(JSON.parse(publicGraphRecall.body).items.some((row) => row.id === memory.id), true,
      "public display-name graph recall still works on open search");

    const attrs = new FakeRes();
    await h.route("/api/dsh-mneme/semantic/graph/entity-attrs").handler(
      req("GET", `/api/dsh-mneme/semantic/graph/entity-attrs?id=${entity.id}`), attrs
    );
    assert.equal(attrs.statusCode, 200);
    const attrsBody = JSON.parse(attrs.body);
    assert.equal("external_ids" in attrsBody.entity, false);
    assert.equal(attrsBody.attrs.every((attr) => !("entity_id" in attr) && !("memory_id" in attr) && !("source" in attr)), true);

    const memoryEntities = new FakeRes();
    await h.route("/api/dsh-mneme/memories/entities").handler(
      req("GET", `/api/dsh-mneme/memories/entities?memoryId=${memory.id}`), memoryEntities
    );
    assert.equal(JSON.parse(memoryEntities.body).entities.every((row) =>
      Object.keys(row).sort().join(",") === "name,type"
    ), true);

    const denied = new FakeRes();
    await h.route("/api/dsh-mneme/identity/entity-detail").handler(
      req("GET", `/api/dsh-mneme/identity/entity-detail?id=${entity.id}`), denied
    );
    assert.equal(denied.statusCode, 401);
    const detail = new FakeRes();
    await h.route("/api/dsh-mneme/identity/entity-detail").handler(
      req("GET", `/api/dsh-mneme/identity/entity-detail?id=${entity.id}`, null, auth), detail
    );
    assert.equal(detail.statusCode, 200);
    const detailBody = JSON.parse(detail.body);
    assert.equal(detailBody.entity.external_ids[0].external_id, "synthetic-private-id");
    assert.equal(detailBody.relations[0].weight, 0.7);
    assert.equal(detailBody.relations[0].source, "test");
  } finally {
    h.close();
  }
});

test("preferences route is readable but writes need auth and validate bounds", async () => {
  const h = setup();
  try {
    const route = h.route("/api/dsh-mneme/preferences");
    const readDenied = new FakeRes();
    await route.handler(req("GET", "/api/dsh-mneme/preferences"), readDenied);
    assert.equal(readDenied.statusCode, 401);
    const read = new FakeRes();
    await route.handler(req("GET", "/api/dsh-mneme/preferences", null, auth), read);
    assert.equal(read.statusCode, 200);
    assert.equal(JSON.parse(read.body).default_weight, 1);
    const denied = new FakeRes();
    await route.handler(req("POST", "/api/dsh-mneme/preferences", {
      target: "tag", action: "set", tag: "close", weight: 1.5
    }), denied);
    assert.equal(denied.statusCode, 401);
    const bad = new FakeRes();
    await route.handler(req("POST", "/api/dsh-mneme/preferences", {
      target: "tag", action: "set", tag: "close", weight: 9
    }, auth), bad);
    assert.equal(bad.statusCode, 400);
    const good = new FakeRes();
    await route.handler(req("POST", "/api/dsh-mneme/preferences", {
      target: "tag", action: "set", tag: "close", weight: 1.5
    }, auth), good);
    assert.equal(good.statusCode, 200);
    assert.equal(JSON.parse(good.body).tags.some((row) => row.tag === "close" && row.weight === 1.5), true);
    const entity = h.store.createEntity({ name: "Aster", type: "person" });
    const setEntity = new FakeRes();
    await route.handler(req("POST", "/api/dsh-mneme/preferences", {
      target: "entity", action: "set", entity_id: entity.id, weight: 0.75
    }, auth), setEntity);
    assert.equal(setEntity.statusCode, 200);
    assert.equal(JSON.parse(setEntity.body).entities.some((row) => row.entity_id === entity.id), true);
    const deleted = new FakeRes();
    await route.handler(req("POST", "/api/dsh-mneme/preferences", {
      target: "entity", action: "delete", entity_id: entity.id
    }, auth), deleted);
    assert.equal(deleted.statusCode, 200);
    assert.equal(JSON.parse(deleted.body).deleted, true);
  } finally {
    h.close();
  }
});
