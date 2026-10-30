// Codex regression for safe accumulation while a name-only person is pending.
// Synthetic data only; no real platform identifiers.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { extractEntities } from "../src/entities/extractor.js";

function open(path = ":memory:") {
  const store = createStore(path);
  const service = createService({ store, mirror: null, config: {} });
  return { store, service, close: () => store.close() };
}

async function extract(memory, h, entities, relations = []) {
  return extractEntities(memory, {
    store: h.store,
    identity: h.service.identity,
    config: {},
    callLLM: async () => JSON.stringify({ entities, relations })
  });
}

test("a safe pending name-only assertion can be recovered from its original memory after confirmation and restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mneme-pending-identity-"));
  const path = join(dir, "memory.db");
  try {
    const h = open(path);
    const first = h.store.save({ type: "history", title: "Synthetic encounter one", content: "Aster joined Project Blue." });
    await extract(first, h, [
      { name: "Aster", type: "person", attrs: [] },
      { name: "Project Blue", type: "project", attrs: [] }
    ]);
    const aster = h.store.findEntityByName("Aster");
    const second = h.store.save({
      type: "history", title: "Synthetic encounter two", content: "Aster became the reviewer for Project Blue."
    });
    const result = await extract(second, h, [
      { name: "Aster", type: "person", attrs: [{ key: "role", value: "reviewer", confidence: 0.95 }] },
      { name: "Project Blue", type: "project", attrs: [] }
    ], [{ from: "Aster", to: "Project Blue", type: "related_to" }]);
    assert.equal(result.unresolved.some((entry) => entry.name === "Aster"), true);
    assert.equal(h.store.getAttrsByMemory(second.id).length, 0, "no guessed attribution before confirmation");
    assert.equal(h.store.getRelations(aster.id).filter((row) => row.memory_id === second.id).length, 0);
    h.close();

    const reopened = open(path);
    try {
      const alias = reopened.service.identity.listAliases({ entity_id: aster.id })
        .find((row) => row.alias === "Aster");
      reopened.service.identity.confirmAlias({ id: alias.id, actor: "human-review" });
      assert.ok(reopened.store.getAttrsByMemory(second.id).some((row) =>
        row.entity_id === aster.id && row.attr_key === "role" && row.attr_value === "reviewer"
      ), "confirmed identity should recover the pending attribute with its source memory");
      assert.ok(reopened.store.getRelations(aster.id).some((row) =>
        row.memory_id === second.id && row.relation_type === "related_to"
      ), "confirmed identity should recover the pending relation with its source memory");
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a name-only assertion with two stable-ID candidates is never attributed by nickname alone", async () => {
  const h = open();
  try {
    const one = h.service.identity.resolveEntityForWrite({
      name: "Twin", type: "person", platform: "qq", external_id: "11111111"
    }).entity;
    const two = h.service.identity.resolveEntityForWrite({
      name: "Twin", type: "person", platform: "qq", external_id: "22222222"
    }).entity;
    const memory = h.store.save({
      type: "history", title: "Ambiguous synthetic chat", content: "Twin reviewed Project Red."
    });
    const result = await extract(memory, h, [
      { name: "Twin", type: "person", attrs: [{ key: "role", value: "reviewer" }] },
      { name: "Project Red", type: "project", attrs: [] }
    ], [{ from: "Twin", to: "Project Red", type: "related_to" }]);
    assert.equal(result.unresolved.some((entry) => entry.name === "Twin"), true);
    assert.equal(h.store.getAttrsByMemory(memory.id).length, 0);
    assert.equal(h.store.getRelations(one.id).filter((row) => row.memory_id === memory.id).length, 0);
    assert.equal(h.store.getRelations(two.id).filter((row) => row.memory_id === memory.id).length, 0);
  } finally {
    h.close();
  }
});

test("a relation between two pending people recovers after both identities are confirmed", async () => {
  const h = open();
  try {
    const first = h.store.save({
      type: "history", title: "Synthetic two people first", content: "Aster and Boreal attended."
    });
    await extract(first, h, [
      { name: "Aster", type: "person", attrs: [] },
      { name: "Boreal", type: "person", attrs: [] }
    ]);
    const aster = h.store.findEntityByName("Aster");
    const boreal = h.store.findEntityByName("Boreal");
    const second = h.store.save({
      type: "history", title: "Synthetic two people second", content: "Aster helped Boreal."
    });
    const result = await extract(second, h, [
      { name: "Aster", type: "person", attrs: [] },
      { name: "Boreal", type: "person", attrs: [] }
    ], [{ from: "Aster", to: "Boreal", type: "related_to" }]);
    assert.equal(result.unresolved.length, 2);
    assert.equal(h.store.getRelations(aster.id).filter(row => row.memory_id === second.id).length, 0);
    const asterAlias = h.service.identity.listAliases({ entity_id: aster.id })
      .find(row => row.alias === "Aster");
    const borealAlias = h.service.identity.listAliases({ entity_id: boreal.id })
      .find(row => row.alias === "Boreal");
    h.service.identity.confirmAlias({ id: asterAlias.id, actor: "human-review" });
    h.service.identity.confirmAlias({ id: borealAlias.id, actor: "human-review" });
    assert.ok(h.store.getRelations(aster.id).some(row =>
      row.memory_id === second.id && row.to_entity === boreal.id
    ), "the source-linked pending relation should recover without guessing either endpoint");
  } finally {
    h.close();
  }
});
