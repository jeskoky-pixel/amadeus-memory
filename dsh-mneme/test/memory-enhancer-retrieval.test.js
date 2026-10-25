// Synthetic retrieval fixture: recall quality, isolation and injection behavior
// for the Amadeus memory enhancer. No real memory or identifiers are used.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { evaluateFixture, seedFixture } from "../scripts/memory-enhancer-fixture.mjs";

function setup(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mneme-retrieval-"));
  const store = createStore(join(dir, "memory.db"));
  const service = createService({ store, mirror: null, config });
  return {
    dir, store, service, config,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function enablePreferences(h) {
  h.config.memoryPreferenceEnabled = true;
  h.service.setTagWeight({ tag: "person:close", weight: 2, actor: "fixture" });
  h.service.setTagWeight({ tag: "event:self_action", weight: 1.8, actor: "fixture" });
  h.service.setTagWeight({ tag: "group:chatter", weight: 0.5, actor: "fixture" });
  h.service.setTagWeight({ tag: "noise:high", weight: 2, actor: "fixture" });
  h.service.setEntityWeight({
    entity_id: h.store.findEntityByName("Aster").id,
    weight: 1.5,
    actor: "fixture"
  });
}

test("preference reranking improves Recall@5 and MRR over the off baseline", async () => {
  const h = setup({});
  try {
    const { byKey } = seedFixture(h.service, h.store);
    const off = await evaluateFixture(h.service, byKey, { topK: 5 });
    assert.equal(off.recall_at_k, 0.3333);
    assert.equal(off.mrr, 0.3333);
    enablePreferences(h);
    const on = await evaluateFixture(h.service, byKey, { topK: 5 });
    assert.ok(on.recall_at_k > off.recall_at_k, `${on.recall_at_k} should exceed ${off.recall_at_k}`);
    assert.ok(on.mrr > off.mrr, `${on.mrr} should exceed ${off.mrr}`);
    assert.equal(on.per_query.every((row) => row.actual.length <= 5), true);
    // Every returned row that carries a preference explains it; no hidden content.
    for (const query of on.per_query) {
      for (const item of query.preferences) {
        assert.ok(item.factor >= 0.6 && item.factor <= 1.6);
      }
    }
  } finally {
    h.close();
  }
});

test("enabled with only 1.0 weights is byte-for-byte the off behavior", async () => {
  const h = setup({ memoryPreferenceEnabled: true });
  try {
    const { byKey } = seedFixture(h.service, h.store);
    for (const tag of ["person:close", "event:self_action", "group:chatter", "noise:high"]) {
      h.service.setTagWeight({ tag, weight: 1.0, actor: "fixture" });
    }
    const one = await evaluateFixture(h.service, byKey, { topK: 5 });
    h.config.memoryPreferenceEnabled = false;
    const off = await evaluateFixture(h.service, byKey, { topK: 5 });
    assert.deepEqual(one.per_query.map((row) => row.actual), off.per_query.map((row) => row.actual));
    assert.equal(one.per_query.some((row) => row.preferences.length > 0), false);
  } finally {
    h.close();
  }
});

test("archived, forgotten, foreign-scope and paused-scope memories stay isolated", async () => {
  const h = setup({ memoryPreferenceEnabled: true, strictScope: true, scopeEnabled: true });
  try {
    const { byKey } = seedFixture(h.service, h.store);
    enablePreferences(h);
    const archived = h.service.saveWithDedupe({
      type: "history", title: "birthday dinner Aster archived", content: "birthday dinner Aster",
      importance: 4, tags: ["person:close"]
    }).memory;
    const forgotten = h.service.saveWithDedupe({
      type: "history", title: "birthday dinner Aster forgotten", content: "birthday dinner Aster",
      importance: 4, tags: ["person:close"]
    }).memory;
    const foreign = h.service.saveWithDedupe({
      type: "history", title: "birthday dinner Aster foreign", content: "birthday dinner Aster",
      importance: 5, tags: ["person:close"],
      agent_scope: "other", agent_scope_source: "explicit",
      workspace_scope: "workspace-a", workspace_scope_source: "explicit"
    }).memory;
    h.service.setArchived(archived.id, true);
    h.service.setForget(forgotten.id, true);
    const rows = await h.service.searchMemories("birthday dinner Aster", {
      topK: 20,
      scope: { agent_scope: "mine", workspace_scope: "workspace-a" },
      recordRecall: false
    });
    const ids = new Set(rows.map((row) => row.id));
    assert.equal(ids.has(archived.id), false);
    assert.equal(ids.has(forgotten.id), false);
    assert.equal(ids.has(foreign.id), false);
    assert.ok(ids.has(byKey.get("close-birthday-0")), "visible relevant fixture row still participates");

    // Paused scope policy axis: rows stay stored but leave the supply face.
    const pausedMemory = h.service.saveWithDedupe({
      type: "history", title: "birthday dinner Aster paused", content: "birthday dinner Aster",
      importance: 5, tags: ["person:close"],
      agent_scope: "mine", agent_scope_source: "explicit",
      workspace_scope: "workspace-a", workspace_scope_source: "explicit"
    }).memory;
    const beforePause = await h.service.searchMemories("birthday dinner Aster paused", {
      topK: 20,
      scope: { agent_scope: "mine", workspace_scope: "workspace-a" },
      recordRecall: false
    });
    assert.equal(beforePause.some((row) => row.id === pausedMemory.id), true);
    h.config.scopeState = { enabled: true, enforce: true };
    h.service.setScopeState({ dimension: "workspace", scope_value: "workspace-a", state: "paused" });
    const paused = await h.service.searchMemories("birthday dinner Aster paused", {
      topK: 20,
      scope: { agent_scope: "mine", workspace_scope: "workspace-a" },
      recordRecall: false
    });
    assert.equal(paused.some((row) => row.id === pausedMemory.id), false);
    // Nothing was deleted: the row is still there for an explicit inspection read.
    assert.ok(h.store.getById(pausedMemory.id));
    h.service.setScopeState({ dimension: "workspace", scope_value: "workspace-a", state: "active" });
  } finally {
    h.close();
  }
});

test("automatic injection uses preferences after gates and excludes archived/forgotten rows", async () => {
  const h = setup({ memoryPreferenceEnabled: true });
  try {
    const { byKey } = seedFixture(h.service, h.store);
    enablePreferences(h);
    const archived = h.service.saveWithDedupe({
      type: "history", title: "weekend plan archived", content: "weekend plan with Aster",
      importance: 5, tags: ["person:close"]
    }).memory;
    h.service.setArchived(archived.id, true);
    const injected = h.service.injectCandidates({
      query: "weekend plan with Aster", maxItems: 5, threshold: 2
    });
    assert.ok(injected.length > 0);
    assert.equal(injected.some((row) => row.id === archived.id), false);
    assert.equal(injected.some((row) => row.id === byKey.get("close-weekend-0")), true);
    assert.equal(injected.some((row) => row.preference?.applied), true);
    for (const row of injected) {
      if (row.preference) {
        assert.ok(row.preference.factor >= 0.6 && row.preference.factor <= 1.6);
      }
    }
  } finally {
    h.close();
  }
});

test("explicit entity search and graph recall both expose canonical identity", async () => {
  const h = setup({ memoryPreferenceEnabled: true, entityRecallEnabled: true });
  try {
    const { byKey } = seedFixture(h.service, h.store);
    enablePreferences(h);
    const byEntity = h.service.searchByEntity("Aster");
    assert.ok(byEntity.length >= 6);
    assert.equal(byEntity.every((row) => row._canonical_id === h.store.findEntityByName("Aster").id), true);
    assert.equal(byEntity.some((row) => row.preference?.applied), true);
    const fused = await h.service.searchMemories("weekend plan Aster", {
      mode: "auto", topK: 5, recordRecall: false
    });
    assert.ok(fused.some((row) => row.id === byKey.get("close-weekend-0")));
    assert.ok(fused.some((row) => row.preference?.applied));
  } finally {
    h.close();
  }
});
