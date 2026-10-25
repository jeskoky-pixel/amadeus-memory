// Read-only enhancer model tools: preference state and safe identity lookup.
// Synthetic data only.
import test from "node:test";
import assert from "node:assert/strict";
import { validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createTools } from "../src/tools.js";

function setup(config = {}) {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config });
  const registered = [];
  const ctx = {
    tools: {
      register(def) {
        registered.push(def);
        return () => {};
      }
    }
  };
  createTools(ctx, service, config, undefined);
  const byName = Object.fromEntries(registered.map((tool) => [tool.name, tool]));
  return { store, service, byName, registered };
}

function assertOutput(tool, value) {
  assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value), []);
}

test("both read-only enhancer tools register with truthful descriptions", () => {
  const { byName } = setup();
  assert.ok(byName.memory_preference_get);
  assert.ok(byName.memory_identity_lookup);
  assert.match(byName.memory_preference_get.description, /read-only/i);
  assert.match(byName.memory_preference_get.description, /cannot .*change/i);
  assert.match(byName.memory_identity_lookup.description, /never .*writes provenance/i);
  assert.match(byName.memory_identity_lookup.description, /instead of guessing/i);
  assert.deepEqual(byName.memory_preference_get.parameters.properties, {});
  assert.equal(byName.memory_identity_lookup.parameters.required.includes("query"), true);
});

test("strict scope does not expose library-wide identity or preference data", () => {
  const { byName } = setup({ strictScope: true, scopeEnabled: true });
  assert.equal(byName.memory_identity_lookup, undefined);
  assert.equal(byName.memory_preference_get, undefined);
});

test("memory_preference_get returns exact state and cannot mutate weights", async () => {
  const { byName, service } = setup({ memoryPreferenceEnabled: true });
  const person = service.identity.resolveEntityForWrite({ name: "Aster", type: "person" }).entity;
  service.setTagWeight({ tag: "person:close", weight: 1.8, actor: "test" });
  service.setEntityWeight({ entity_id: person.id, weight: 1.4, actor: "test" });
  const tool = byName.memory_preference_get;
  const before = service.getPreferenceState();
  const result = await tool.execute({});
  assertOutput(tool, result);
  assert.equal(result.enabled, true);
  assert.equal(result.tags.length, 1);
  assert.equal(result.tags[0].tag, "person:close");
  assert.equal(result.tags[0].weight, 1.8);
  assert.equal(result.entities.length, 1);
  assert.equal(result.entities[0].entity_id, person.id);
  assert.equal(result.entities[0].canonical_id, person.id);
  assert.equal(result.entities[0].weight, 1.4);
  assert.equal(result.tags_truncated, false);
  assert.equal(result.entities_truncated, false);
  const after = service.getPreferenceState();
  assert.deepEqual(after, before, "preference get must be a pure read");
  const text = tool.output.render({}, result)[0].text;
  assert.match(text, /person:close = 1.8/);
  assert.match(text, /Aster \[person\]/);
});

test("preference get is truthful when the feature is disabled", async () => {
  const { byName } = setup({ memoryPreferenceEnabled: false });
  const result = await byName.memory_preference_get.execute({});
  assertOutput(byName.memory_preference_get, result);
  assert.equal(result.enabled, false);
});

test("memory_identity_lookup resolves UUID/name/alias without exposing external IDs", async () => {
  const { byName, service, store } = setup();
  const person = service.identity.resolveEntityForWrite({
    name: "Aster", type: "person", platform: "qq", external_id: "synthetic-ext-9911"
  }).entity;
  service.identity.createAlias({
    entity_id: person.id, alias: "Aster Alias", confirmed: true, actor: "test"
  });
  const projectEntity = store.createEntity({ name: "Project Blue", type: "project" });
  service.saveRelation({
    from_entity: person.id, to_entity: projectEntity.id,
    relation_type: "related_to", memory_id: "synthetic-memory", source: "test"
  });
  const tool = byName.memory_identity_lookup;
  const byId = await tool.execute({ query: person.id });
  assertOutput(tool, byId);
  assert.equal(byId.status, "resolved");
  assert.equal(byId.entity.id, person.id);
  assert.equal(byId.entity.canonical_id, person.id);
  assert.equal(byId.entity.type, "person");
  assert.equal(byId.entity.name, "Aster");
  assert.equal(byId.entity.member_ids.includes(person.id), true);
  assert.equal(byId.entity.aliases.some((row) => row.alias === "Aster Alias" && row.confirmed), true);
  assert.equal(byId.entity.relation_summary.total, 1);
  assert.equal(byId.entity.relation_summary.items[0].entity_id, projectEntity.id);

  const byNameResult = await tool.execute({ query: "Aster Alias" });
  assertOutput(tool, byNameResult);
  assert.equal(byNameResult.status, "resolved");
  assert.equal(byNameResult.entity.id, person.id);
  const serialized = JSON.stringify(byId);
  assert.equal(serialized.includes("synthetic-ext-9911"), false, "external IDs are not exposed");
  const externalIdProbe = await tool.execute({ query: "synthetic-ext-9911" });
  assert.equal(externalIdProbe.status, "unresolved", "lookup accepts names/UUIDs, not external IDs");
});

test("memory_identity_lookup returns unresolved/ambiguous without creating or guessing", async () => {
  const { byName, store } = setup();
  const tool = byName.memory_identity_lookup;
  const before = store.listEntities({ limit: 1000000 }).length;
  const missing = await tool.execute({ query: "No Such Entity" });
  assertOutput(tool, missing);
  assert.equal(missing.status, "unresolved");
  assert.deepEqual(missing.candidates, []);
  const missingUuid = await tool.execute({ query: "00000000-0000-4000-8000-000000000000" });
  assert.equal(missingUuid.status, "unresolved");

  store.createEntity({ name: "Twin", type: "person" });
  store.createEntity({ name: "Twin", type: "project" });
  const ambiguous = await tool.execute({ query: "Twin" });
  assertOutput(tool, ambiguous);
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.candidates.length, 2);
  assert.deepEqual(ambiguous.candidates.map((row) => row.type).sort(), ["person", "project"]);
  assert.equal(ambiguous.entity, undefined);
  assert.equal(store.listEntities({ limit: 1000000 }).length, before + 2, "lookup never creates entities");
});

test("identity lookup rejects an empty query", async () => {
  const { byName } = setup();
  await assert.rejects(() => byName.memory_identity_lookup.execute({ query: "   " }), /non-empty/);
});

test("identity relation summary is bounded and discloses truncation", async () => {
  const { byName, store } = setup();
  const center = store.createEntity({ name: "Hub", type: "person" });
  for (let i = 0; i < 25; i++) {
    const other = store.createEntity({ name: `Other ${i}`, type: "project" });
    store.saveRelation({
      from_entity: center.id, to_entity: other.id,
      relation_type: "related_to", memory_id: `synthetic-${i}`, source: "test"
    });
  }
  const result = await byName.memory_identity_lookup.execute({ query: "Hub" });
  assertOutput(byName.memory_identity_lookup, result);
  assert.equal(result.status, "resolved");
  assert.equal(result.entity.relation_summary.total, 25);
  assert.equal(result.entity.relation_summary.items.length, 20);
  assert.equal(result.entity.relation_summary.truncated, true);
});
