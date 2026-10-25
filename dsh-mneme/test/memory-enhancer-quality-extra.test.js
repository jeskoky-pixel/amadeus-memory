// Focused repairs around trusted-event authenticity, request-id durability,
// additive migration and pending-identity selection.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { extractEntities } from "../src/entities/extractor.js";

function experience(overrides = {}) {
  return {
    kind: "self_action",
    status: "completed",
    participation: "agent",
    trust_source: "system",
    actor: "life-extra",
    title: "Synthetic extra experience",
    content: "Life completed a synthetic extra experience.",
    scope: { agent_scope: "amadeus", workspace_scope: "life-test" },
    evidence: [{ kind: "receipt", value: "synthetic-extra" }],
    ...overrides
  };
}

test("future and compatibility-case event tags are stripped from ordinary writes and rejected by intake", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: { trustedIntakeEnabled: true } });
  try {
    const saved = service.saveWithDedupe({
      type: "history", title: "Future event probe", content: "Synthetic",
      tags: ["custom", "event:future_claim", "EVENT:future_claim", "ｅｖｅｎｔ：ｆｕｔｕｒｅ＿ｃｌａｉｍ"]
    });
    assert.deepEqual(saved.memory.tags, ["custom"]);
    assert.throws(
      () => service.submitTrustedMemory(experience({ tags: ["event:future_claim"] })),
      (error) => error.name === "IntakeError" && error.code === "invalid-event-tag"
    );
  } finally {
    store.close();
  }
});

test("pending assertion payload is bounded by relation count and serialized bytes", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  try {
    const attrs = Array.from({ length: 120 }, (_, i) => ({ key: `k${i}`, value: "v", confidence: 0.5 }));
    const relations = Array.from({ length: 500 }, (_, i) => ({
      from_name: "Bound", from_entity_id: null,
      to_name: `Other ${i}`, to_entity_id: null, relation_type: "related_to"
    }));
    service.identity.recordPendingAssertion({
      memory_id: "synthetic-bounded-memory",
      display_name: "Bound",
      entity_type: "person",
      attrs,
      relations,
      candidates: [],
      evidence: [{ kind: "memory", value: "synthetic-bounded-memory" }]
    });
    const pending = service.listPendingAssertions({ status: "pending" })[0];
    assert.ok(pending);
    assert.ok(pending.payload.relations.length <= 40);
    assert.ok(pending.payload.attrs.length <= 40);
    assert.ok(Buffer.byteLength(JSON.stringify(pending.payload), "utf8") <= 16 * 1024);
    assert.equal(pending.payload.truncated, true);
  } finally {
    store.close();
  }
});

test("two genuinely overlapping submissions replay one request_id without a second write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mneme-idem-concurrent-"));
  const withTimeout = (promise, ms, label) => {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
        timer.unref?.();
      })
    ]).finally(() => clearTimeout(timer));
  };
  const attempt = async (attemptNumber) => {
    const path = join(dir, `memory-${attemptNumber}.db`);
    const barrier = new SharedArrayBuffer(4);
    const start = () => {
      const worker = new Worker(new URL("./helpers/intake-worker.mjs", import.meta.url), {
        workerData: { path, payload: experience({ request_id: `concurrent-request-${attemptNumber}` }), barrier }
      });
      let resolveReady;
      let rejectReady;
      let readySettled = false;
      const ready = new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      let resolveResult;
      let rejectResult;
      const result = new Promise((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });
      const fail = (error) => {
        if (!readySettled) {
          readySettled = true;
          rejectReady(error);
        }
        rejectResult(error);
      };
      worker.on("message", (message) => {
        if (message.ready) {
          if (!readySettled) {
            readySettled = true;
            resolveReady();
          }
          return;
        }
        resolveResult(message);
      });
      worker.on("error", fail);
      worker.on("exit", (code) => {
        if (code !== 0) fail(new Error(`intake worker exited with code ${code}`));
      });
      return { worker, ready, result };
    };
    const a = start();
    const b = start();
    try {
      await withTimeout(Promise.all([a.ready, b.ready]), 20_000, "worker readiness");
      Atomics.store(new Int32Array(barrier), 0, 1);
      Atomics.notify(new Int32Array(barrier), 0, 2);
      const [first, second] = await withTimeout(Promise.all([a.result, b.result]), 20_000, "worker result");
      assert.equal(first.ok, true, JSON.stringify(first));
      assert.equal(second.ok, true, JSON.stringify(second));
      assert.equal(second.memoryId, first.memoryId);
      assert.equal(second.provenanceId, first.provenanceId);
      assert.equal([first.replayed, second.replayed].filter(Boolean).length, 1);
      const check = createStore(path);
      try {
        assert.equal(check.db.prepare("SELECT COUNT(*) AS n FROM memories").get().n, 1);
        assert.equal(check.db.prepare("SELECT COUNT(*) AS n FROM memory_trusted_provenance").get().n, 1);
        assert.equal(check.db.prepare("SELECT COUNT(*) AS n FROM memory_trusted_requests").get().n, 1);
      } finally {
        check.close();
      }
    } finally {
      await a.worker.terminate();
      await b.worker.terminate();
    }
  };
  try {
    let lastError;
    // Startup under a nested test runner can be transiently slow; two retries
    // keep the true-overlap assertion without turning a worker-start hiccup
    // into an unbounded test timeout.
    for (let attemptNumber = 1; attemptNumber <= 3; attemptNumber++) {
      try {
        await attempt(attemptNumber);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("additive request table migration tolerates duplicate historical request_id rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "mneme-idem-migrate-"));
  const path = join(dir, "old.db");
  try {
    const old = createStore(path);
    const at = new Date().toISOString();
    old.db.prepare(
      `INSERT INTO memory_trusted_provenance
         (id, memory_id, kind, actor, participation, trust_source, status, occurred_at,
          agent_scope, workspace_scope, evidence, request_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("old-prov-1", "old-memory-1", "self_action", "life-old", "agent", "system",
      "completed", null, "amadeus", "life-test", "[]", "historical-duplicate", at);
    old.db.prepare(
      `INSERT INTO memory_trusted_provenance
         (id, memory_id, kind, actor, participation, trust_source, status, occurred_at,
          agent_scope, workspace_scope, evidence, request_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("old-prov-2", "old-memory-2", "self_action", "life-old", "agent", "system",
      "completed", null, "amadeus", "life-test", "[]", "historical-duplicate", at);
    old.db.exec("DROP TABLE memory_trusted_requests");
    old.close();

    const reopened = createStore(path);
    const service = createService({ store: reopened, mirror: null, config: { trustedIntakeEnabled: true } });
    try {
      assert.equal(reopened.db.prepare(
        "SELECT COUNT(*) AS n FROM memory_trusted_provenance WHERE request_id = 'historical-duplicate'"
      ).get().n, 2, "historical duplicate rows are preserved");
      const saved = service.submitTrustedMemory(experience({ request_id: "post-migration-request" }));
      assert.ok(saved.memory.id);
      assert.equal(reopened.db.prepare(
        "SELECT COUNT(*) AS n FROM memory_trusted_requests WHERE request_id = 'post-migration-request'"
      ).get().n, 1);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recovered pending assertions are committed across restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mneme-pending-commit-"));
  const path = join(dir, "memory.db");
  try {
    const first = createStore(path);
    const firstService = createService({ store: first, mirror: null, config: {} });
    const memory = first.save({
      type: "history", title: "Synthetic pending commit", content: "Aster joined Project Blue."
    });
    await extractEntities(memory, {
      store: first, identity: firstService.identity, config: {},
      callLLM: async () => JSON.stringify({
        entities: [
          { name: "Aster", type: "person", attrs: [] },
          { name: "Project Blue", type: "project", attrs: [] }
        ],
        relations: []
      })
    });
    const second = first.save({
      type: "history", title: "Synthetic pending commit two", content: "Aster became the reviewer."
    });
    await extractEntities(second, {
      store: first, identity: firstService.identity, config: {},
      callLLM: async () => JSON.stringify({
        entities: [
          { name: "Aster", type: "person", attrs: [{ key: "role", value: "reviewer" }] },
          { name: "Project Blue", type: "project", attrs: [] }
        ],
        relations: [{ from: "Aster", to: "Project Blue", type: "related_to" }]
      })
    });
    const aster = first.findEntityByName("Aster");
    first.close();

    const secondHandle = createStore(path);
    const secondService = createService({ store: secondHandle, mirror: null, config: {} });
    const alias = secondService.identity.listAliases({ entity_id: aster.id })
      .find((row) => row.alias === "Aster");
    secondService.identity.confirmAlias({ id: alias.id, actor: "human-review" });
    secondHandle.close();

    const third = createStore(path);
    try {
      assert.ok(third.getAttrsByMemory(second.id).some((row) =>
        row.entity_id === aster.id && row.attr_key === "role" && row.attr_value === "reviewer"
      ), "recovered attr survives restart");
      assert.ok(third.getRelations(aster.id).some((row) => row.memory_id === second.id));
      assert.equal(third.db.prepare(
        "SELECT COUNT(*) AS n FROM identity_pending_assertions WHERE status = 'applied'"
      ).get().n, 1);
    } finally {
      third.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed pending recovery rolls back alias confirmation and retains the pending assertion", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  try {
    const first = store.save({
      type: "history", title: "Synthetic recovery failure one", content: "Aster joined Project Blue."
    });
    await extractEntities(first, {
      store, identity: service.identity, config: {},
      callLLM: async () => JSON.stringify({
        entities: [
          { name: "Aster", type: "person", attrs: [] },
          { name: "Project Blue", type: "project", attrs: [] }
        ],
        relations: []
      })
    });
    const second = store.save({
      type: "history", title: "Synthetic recovery failure two", content: "Aster became the reviewer."
    });
    await extractEntities(second, {
      store, identity: service.identity, config: {},
      callLLM: async () => JSON.stringify({
        entities: [
          { name: "Aster", type: "person", attrs: [{ key: "role", value: "reviewer" }] },
          { name: "Project Blue", type: "project", attrs: [] }
        ],
        relations: []
      })
    });
    const aster = store.findEntityByName("Aster");
    const alias = service.identity.listAliases({ entity_id: aster.id }).find((row) => row.alias === "Aster");
    store.db.exec(`
      CREATE TRIGGER synthetic_pending_failure
      BEFORE INSERT ON entity_attrs
      WHEN NEW.attr_key = 'role'
      BEGIN SELECT RAISE(ABORT, 'synthetic recovery failure'); END;
    `);
    assert.throws(
      () => service.identity.confirmAlias({ id: alias.id, actor: "human" }),
      (error) => error.code === "pending-recovery-failed"
    );
    assert.equal(service.identity.listAliases({ entity_id: aster.id }).find((row) => row.id === alias.id).confirmed, false);
    assert.equal(service.listPendingAssertions({ status: "pending" }).length, 1);
    assert.equal(store.getAttrsByMemory(second.id).length, 0);
    store.db.exec("DROP TRIGGER synthetic_pending_failure");
    service.identity.confirmAlias({ id: alias.id, actor: "human" });
    assert.equal(service.identity.listAliases({ entity_id: aster.id }).find((row) => row.id === alias.id).confirmed, true);
    assert.equal(service.listPendingAssertions({ status: "pending" }).length, 0);
    assert.equal(store.getAttrsByMemory(second.id).length, 1);
  } finally {
    store.close();
  }
});

test("recovery cannot resurrect forgotten or deleted source evidence", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  try {
    const first = store.save({
      type: "history", title: "Synthetic stale source one", content: "Aster joined Project Blue."
    });
    await extractEntities(first, {
      store, identity: service.identity, config: {},
      callLLM: async () => JSON.stringify({
        entities: [
          { name: "Aster", type: "person", attrs: [] },
          { name: "Project Blue", type: "project", attrs: [] }
        ],
        relations: []
      })
    });
    const second = store.save({
      type: "history", title: "Synthetic stale source two", content: "Aster became the reviewer."
    });
    await extractEntities(second, {
      store, identity: service.identity, config: {},
      callLLM: async () => JSON.stringify({
        entities: [
          { name: "Aster", type: "person", attrs: [{ key: "role", value: "reviewer" }] },
          { name: "Project Blue", type: "project", attrs: [] }
        ],
        relations: [{ from: "Aster", to: "Project Blue", type: "related_to" }]
      })
    });
    const aster = store.findEntityByName("Aster");
    const alias = service.identity.listAliases({ entity_id: aster.id }).find((row) => row.alias === "Aster");
    service.setForget(second.id, true);
    service.identity.confirmAlias({ id: alias.id, actor: "human" });
    assert.equal(store.getAttrsByMemory(second.id).length, 0,
      "forgotten source must not contribute recovered attrs");
    assert.equal(store.getRelations(aster.id).filter((row) => row.memory_id === second.id).length, 0,
      "forgotten source must not contribute recovered relations");
    const stale = service.listPendingAssertions({ status: "stale" });
    assert.equal(stale.length, 1, "pending row is marked stale, not applied");

    // Explicit selection on a destroyed source is refused and leaves the row pending.
    const cedarOne = store.save({
      type: "history", title: "Synthetic Cedar one", content: "Cedar joined Project Blue."
    });
    await extractEntities(cedarOne, {
      store, identity: service.identity, config: {},
      callLLM: async () => JSON.stringify({
        entities: [
          { name: "Cedar", type: "person", attrs: [] },
          { name: "Project Blue", type: "project", attrs: [] }
        ],
        relations: []
      })
    });
    const cedarTwo = store.save({
      type: "history", title: "Synthetic Cedar two", content: "Cedar reviewed again."
    });
    await extractEntities(cedarTwo, {
      store, identity: service.identity, config: {},
      callLLM: async () => JSON.stringify({
        entities: [{ name: "Cedar", type: "person", attrs: [{ key: "role", value: "reviewer" }] }],
        relations: []
      })
    });
    const cedar = store.findEntityByName("Cedar");
    const pending = service.listPendingAssertions({ status: "pending" })
      .find((row) => row.memory_id === cedarTwo.id);
    assert.ok(pending);
    store.remove(cedarTwo.id);
    assert.throws(
      () => service.resolvePendingAssertion({ id: pending.id, entity_id: cedar.id, actor: "human" }),
      (error) => error.code === "pending-source-unavailable"
    );
    assert.ok(service.listPendingAssertions({ status: "pending" }).some((row) => row.id === pending.id));
    assert.equal(store.getRelations(cedar.id).filter((row) => row.memory_id === cedarTwo.id).length, 0);
  } finally {
    store.close();
  }
});

test("a pending relation between two people survives restart and recovers once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mneme-pending-relation-restart-"));
  const path = join(dir, "memory.db");
  try {
    const first = createStore(path);
    const firstService = createService({ store: first, mirror: null, config: {} });
    const one = first.save({
      type: "history", title: "Synthetic relation restart one", content: "Aster and Boreal attended."
    });
    await extractEntities(one, {
      store: first, identity: firstService.identity, config: {},
      callLLM: async () => JSON.stringify({
        entities: [
          { name: "Aster", type: "person", attrs: [] },
          { name: "Boreal", type: "person", attrs: [] }
        ],
        relations: []
      })
    });
    const aster = first.findEntityByName("Aster");
    const boreal = first.findEntityByName("Boreal");
    const two = first.save({
      type: "history", title: "Synthetic relation restart two", content: "Aster helped Boreal."
    });
    await extractEntities(two, {
      store: first, identity: firstService.identity, config: {},
      callLLM: async () => JSON.stringify({
        entities: [
          { name: "Aster", type: "person", attrs: [] },
          { name: "Boreal", type: "person", attrs: [] }
        ],
        relations: [{ from: "Aster", to: "Boreal", type: "related_to" }]
      })
    });
    assert.equal(firstService.listPendingRelations({ status: "pending" }).length, 1);
    first.close();

    const second = createStore(path);
    const secondService = createService({ store: second, mirror: null, config: {} });
    const asterAlias = secondService.identity.listAliases({ entity_id: aster.id })
      .find((row) => row.alias === "Aster");
    const borealAlias = secondService.identity.listAliases({ entity_id: boreal.id })
      .find((row) => row.alias === "Boreal");
    secondService.identity.confirmAlias({ id: asterAlias.id, actor: "human-review" });
    assert.equal(second.getRelations(aster.id).filter((row) => row.memory_id === two.id).length, 0);
    assert.equal(secondService.listPendingRelations({ status: "pending" }).length, 1);
    secondService.identity.confirmAlias({ id: borealAlias.id, actor: "human-review" });
    const recovered = second.getRelations(aster.id)
      .filter((row) => row.memory_id === two.id && row.to_entity === boreal.id);
    assert.equal(recovered.length, 1, "recovery must create exactly one relation");
    assert.equal(secondService.listPendingRelations({ status: "pending" }).length, 0);
    await extractEntities(two, {
      store: second, identity: secondService.identity, config: {},
      callLLM: async () => JSON.stringify({
        entities: [
          { name: "Aster", type: "person", attrs: [] },
          { name: "Boreal", type: "person", attrs: [] }
        ],
        relations: [{ from: "Aster", to: "Boreal", type: "related_to" }]
      })
    });
    assert.equal(second.getRelations(aster.id)
      .filter((row) => row.memory_id === two.id && row.to_entity === boreal.id).length, 1,
    "re-extraction must not duplicate the recovered relation");
    second.close();

    const third = createStore(path);
    try {
      assert.equal(third.getRelations(aster.id)
        .filter((row) => row.memory_id === two.id && row.to_entity === boreal.id).length, 1,
      "recovered relation survives restart");
    } finally {
      third.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two stable-ID people sharing a name do not resolve a pending relation by nickname", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  try {
    const one = service.identity.resolveEntityForWrite({
      name: "Twin", type: "person", platform: "qq", external_id: "11111111"
    }).entity;
    const two = service.identity.resolveEntityForWrite({
      name: "Twin", type: "person", platform: "qq", external_id: "22222222"
    }).entity;
    const memory = store.save({
      type: "history", title: "Synthetic twin relation", content: "Twin reviewed Project Red."
    });
    await extractEntities(memory, {
      store, identity: service.identity, config: {},
      callLLM: async () => JSON.stringify({
        entities: [
          { name: "Twin", type: "person", attrs: [{ key: "role", value: "reviewer" }] },
          { name: "Project Red", type: "project", attrs: [] }
        ],
        relations: [{ from: "Twin", to: "Project Red", type: "related_to" }]
      })
    });
    const project = store.findEntityByName("Project Red");
    const alias = service.identity.listAliases({ entity_id: one.id }).find((row) => row.alias === "Twin");
    service.identity.confirmAlias({ id: alias.id, actor: "human-review" });
    assert.equal(store.getRelations(one.id).filter((row) => row.memory_id === memory.id).length, 0);
    assert.equal(store.getRelations(two.id).filter((row) => row.memory_id === memory.id).length, 0);
    assert.equal(service.listPendingRelations({ status: "pending" }).length, 1,
      "same-name stable-ID endpoint stays pending after one nickname confirmation");

    const pending = service.listPendingAssertions({ status: "pending" })
      .find((row) => row.memory_id === memory.id && row.normalized_name === "twin");
    assert.ok(pending);
    service.resolvePendingAssertion({ id: pending.id, entity_id: two.id, actor: "human-selection" });
    assert.equal(store.getRelations(two.id).filter((row) =>
      row.memory_id === memory.id && row.from_entity === two.id && row.to_entity === project.id
    ).length, 1, "explicit selection supplies the endpoint UUID without name guessing");
    assert.equal(store.getRelations(one.id).filter((row) => row.memory_id === memory.id).length, 0);
    assert.equal(service.listPendingRelations({ status: "pending" }).length, 0);
  } finally {
    store.close();
  }
});

test("pending relation is not written when an endpoint violates the type boundary", () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  try {
    const memory = store.save({
      type: "history", title: "Synthetic relation boundary", content: "Twin helped Project Blue."
    });
    const twin = service.identity.resolveEntityForWrite({
      name: "Twin", type: "person", platform: "qq", external_id: "33333333"
    }).entity;
    const project = store.createEntity({ name: "Project Blue", type: "project" });
    service.identity.recordPendingRelation({
      memory_id: memory.id,
      from_name: "Twin", from_entity_type: "person",
      to_name: "Project Blue", to_entity_id: project.id, to_entity_type: "group",
      relation_type: "related_to",
      evidence: [{ kind: "memory", value: memory.id }]
    });
    const alias = service.identity.listAliases({ entity_id: twin.id }).find((row) => row.alias === "Twin");
    service.identity.confirmAlias({ id: alias.id, actor: "human-review" });
    assert.equal(store.getRelations(twin.id).filter((row) => row.memory_id === memory.id).length, 0);
    assert.equal(service.listPendingRelations({ status: "pending" }).length, 1);
  } finally {
    store.close();
  }
});

test("pending relations with a forgotten source are marked stale, never recovered", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  try {
    const one = store.save({
      type: "history", title: "Synthetic stale relation one", content: "Aster and Boreal attended."
    });
    await extractEntities(one, {
      store, identity: service.identity, config: {},
      callLLM: async () => JSON.stringify({
        entities: [
          { name: "Aster", type: "person", attrs: [] },
          { name: "Boreal", type: "person", attrs: [] }
        ],
        relations: []
      })
    });
    const aster = store.findEntityByName("Aster");
    const boreal = store.findEntityByName("Boreal");
    const two = store.save({
      type: "history", title: "Synthetic stale relation two", content: "Aster helped Boreal."
    });
    await extractEntities(two, {
      store, identity: service.identity, config: {},
      callLLM: async () => JSON.stringify({
        entities: [
          { name: "Aster", type: "person", attrs: [] },
          { name: "Boreal", type: "person", attrs: [] }
        ],
        relations: [{ from: "Aster", to: "Boreal", type: "related_to" }]
      })
    });
    service.setForget(two.id, true);
    const asterAlias = service.identity.listAliases({ entity_id: aster.id }).find((row) => row.alias === "Aster");
    const borealAlias = service.identity.listAliases({ entity_id: boreal.id }).find((row) => row.alias === "Boreal");
    service.identity.confirmAlias({ id: asterAlias.id, actor: "human-review" });
    service.identity.confirmAlias({ id: borealAlias.id, actor: "human-review" });
    assert.equal(store.getRelations(aster.id).filter((row) => row.memory_id === two.id).length, 0);
    assert.equal(service.listPendingRelations({ status: "pending" }).length, 0);
    assert.equal(service.listPendingRelations({ status: "stale" }).length, 1);
  } finally {
    store.close();
  }
});

test("an ambiguous pending person assertion can be resolved by explicit human selection", async () => {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  try {
    const one = service.identity.resolveEntityForWrite({
      name: "Twin", type: "person", platform: "qq", external_id: "11111111"
    }).entity;
    const two = service.identity.resolveEntityForWrite({
      name: "Twin", type: "person", platform: "qq", external_id: "22222222"
    }).entity;
    const memory = store.save({
      type: "history", title: "Synthetic ambiguous selection", content: "Twin reviewed Project Red."
    });
    const extracted = await extractEntities(memory, {
      store, identity: service.identity, config: {},
      callLLM: async () => JSON.stringify({
        entities: [
          { name: "Twin", type: "person", attrs: [{ key: "role", value: "reviewer" }] },
          { name: "Project Red", type: "project", attrs: [] }
        ],
        relations: [{ from: "Twin", to: "Project Red", type: "related_to" }]
      })
    });
    assert.equal(extracted.unresolved.some((entry) => entry.name === "Twin"), true);
    const pending = service.listPendingAssertions({ status: "pending" })
      .find((row) => row.memory_id === memory.id && row.normalized_name === "twin");
    assert.ok(pending);
    assert.equal(store.getAttrsByMemory(memory.id).length, 0);
    const resolved = service.resolvePendingAssertion({
      id: pending.id, entity_id: two.id, actor: "human-selection"
    });
    assert.equal(resolved.attrs, 1);
    assert.equal(store.getAttrsByMemory(memory.id).filter((row) => row.entity_id === two.id).length, 1);
    assert.equal(store.getAttrsByMemory(memory.id).filter((row) => row.entity_id === one.id).length, 0);
    assert.equal(store.getRelations(two.id).filter((row) => row.memory_id === memory.id).length, 1);
    assert.equal(store.getRelations(one.id).filter((row) => row.memory_id === memory.id).length, 0);
    assert.equal(service.listPendingAssertions({ status: "pending" })
      .some((row) => row.id === pending.id), false);
  } finally {
    store.close();
  }
});
