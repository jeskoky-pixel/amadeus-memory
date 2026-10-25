// Opt-in memory preference weights (Amadeus memory enhancer). Synthetic data.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import {
  PREFERENCE_FACTOR_MAX,
  PREFERENCE_FACTOR_MIN,
  PREFERENCE_RELEVANCE_FLOOR
} from "../src/preferences.js";

function setup(config = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mneme-pref-"));
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

test("tag weight CRUD validates range and normalizes keys", () => {
  const h = setup();
  try {
    assert.throws(
      () => h.service.setTagWeight({ tag: "urgent", weight: 0.2, actor: "test" }),
      (error) => error.code === "invalid-weight"
    );
    assert.throws(
      () => h.service.setTagWeight({ tag: "urgent", weight: 2.1, actor: "test" }),
      (error) => error.code === "invalid-weight"
    );
    const row = h.service.setTagWeight({ tag: "  Urgent  ", weight: 1.5, actor: "test" });
    assert.equal(row.tag, "urgent");
    assert.equal(row.weight, 1.5);
    assert.equal(h.service.setTagWeight({ tag: "urgent", weight: 0.5, actor: "test" }).weight, 0.5);
    assert.equal(h.service.listTagWeights().length, 1);
    assert.equal(h.service.deleteTagWeight({ tag: "urgent", actor: "test" }), true);
    assert.equal(h.service.deleteTagWeight({ tag: "urgent", actor: "test" }), false);
    assert.equal(h.service.listTagWeights().length, 0);
  } finally {
    h.close();
  }
});

test("event tag preferences require committed trusted provenance", () => {
  const h = setup({ memoryPreferenceEnabled: true, trustedIntakeEnabled: true });
  try {
    h.service.setTagWeight({ tag: "event:self_action", weight: 1.8, actor: "test" });
    const trusted = h.service.submitTrustedMemory({
      kind: "self_action",
      status: "completed",
      participation: "agent",
      trust_source: "system",
      actor: "life-pref-test",
      title: "Synthetic provenance-backed event",
      content: "Life completed a synthetic event.",
      scope: { agent_scope: "amadeus", workspace_scope: "life-test" },
      evidence: [{ kind: "receipt", value: "synthetic-pref" }]
    });
    const spoofed = h.store.save({
      type: "history",
      title: "Synthetic legacy spoofed event",
      content: "Old row with an unbacked event tag.",
      tags: ["event:self_action", "ｅｖｅｎｔ：ｓｅｌｆ＿ａｃｔｉｏｎ"]
    });
    const scorer = h.service.preferences.createScorer();
    const trustedFactor = scorer.factorFor(h.store.getById(trusted.memory.id));
    const spoofedFactor = scorer.factorFor(spoofed);
    assert.equal(trustedFactor.applied, true);
    assert.equal(trustedFactor.factor, 1.6);
    assert.deepEqual(spoofedFactor.tags, []);
    assert.equal(spoofedFactor.applied, false);
    assert.equal(spoofedFactor.factor, 1);
    assert.deepEqual(h.service.toApiList([spoofed])[0].tags, [],
      "unbacked legacy event tags are hidden from API/claim display");
    assert.deepEqual(h.service.toApiList([h.store.getById(trusted.memory.id)])[0].tags,
      ["event:self_action"]);
  } finally {
    h.close();
  }
});

test("canonical entity weights survive a merge and use the strongest member", () => {
  const h = setup();
  try {
    const left = h.store.createEntity({ name: "Aster", type: "person" });
    const right = h.store.createEntity({ name: "Aster", type: "person" });
    h.service.setEntityWeight({ entity_id: left.id, weight: 0.5, actor: "test" });
    h.service.setEntityWeight({ entity_id: right.id, weight: 1.8, actor: "test" });
    const report = h.service.identity.dryRunMerge({ from_entity: left.id, to_entity: right.id, actor: "test" });
    h.service.identity.confirmMerge({ report_id: report.report_id, actor: "test" });
    const state = h.service.getPreferenceState();
    assert.equal(state.enabled, false);
    assert.equal(state.entities.length, 1, "one canonical entity row after the merge");
    assert.equal(state.entities[0].weight, 1.8);
    const scorer = (() => {
      // Force the flag on for the scorer only.
      h.config.memoryPreferenceEnabled = true;
      return h.service.preferences.createScorer();
    })();
    const memory = h.service.saveWithDedupe({
      type: "history", title: "Aster note", content: "note", importance: 3
    }).memory;
    h.store.saveAttr({ entity_id: left.id, attr_key: "city", attr_value: "Turku", memory_id: memory.id, source: "test" });
    const info = scorer.factorFor(memory);
    assert.equal(info.applied, true);
    assert.ok(info.entities.some((entity) => entity.weight === 1.8));
    assert.ok(Math.abs(info.factor - 1.6) < 1e-9, "one 1.8 entity weight stays below the clamp");
    assert.equal(h.service.deleteEntityWeight({ entity_id: left.id, actor: "test" }), true);
  } finally {
    h.close();
  }
});

test("combination clamps many high/low tag weights and never explodes", () => {
  const h = setup({ memoryPreferenceEnabled: true });
  try {
    for (const tag of ["a", "b", "c", "d", "e"]) {
      h.service.setTagWeight({ tag, weight: 2, actor: "test" });
    }
    const memory = h.service.saveWithDedupe({
      type: "history", title: "tagged", tags: ["a", "b", "c", "d", "e"], content: "x", importance: 3
    }).memory;
    const scorer = h.service.preferences.createScorer();
    const high = scorer.factorFor(memory);
    assert.equal(high.factor, PREFERENCE_FACTOR_MAX);
    assert.equal(high.clamped, true);
    for (const tag of ["a", "b", "c", "d", "e"]) h.service.setTagWeight({ tag, weight: 0.5, actor: "test" });
    const low = h.service.preferences.createScorer().factorFor(memory);
    assert.equal(low.factor, PREFERENCE_FACTOR_MIN);
    assert.equal(low.clamped, true);
  } finally {
    h.close();
  }
});

test("rerank uses a relevance floor so unrelated high-weight rows cannot win", () => {
  const h = setup({ memoryPreferenceEnabled: true });
  try {
    h.service.setTagWeight({ tag: "close", weight: 2, actor: "test" });
    const scorer = h.service.preferences.createScorer();
    const rows = [
      { id: "relevant", score: 1.0, tags: [] },
      { id: "near", score: 0.7, tags: ["close"] },
      { id: "unrelated", score: 0.2, tags: ["close"] }
    ];
    const out = h.service.preferences.rerankRows(rows, { scorer, lim: 2 });
    assert.deepEqual(out.map((row) => row.id), ["near", "relevant"]);
    assert.equal(out[0].preference.factor, 1.6);
    assert.equal(out[0].preference.eligible, true);
    assert.equal(out.some((row) => row.id === "unrelated"), false);
    assert.equal(0.2 * 1.6 < 1.0 * PREFERENCE_RELEVANCE_FLOOR, true);
  } finally {
    h.close();
  }
});

test("off and all-1.0 paths preserve legacy search results", async () => {
  const h = setup({});
  try {
    // Baseline: flag off, no weights.
    const ids = [];
    for (let i = 0; i < 5; i++) {
      ids.push(h.service.saveWithDedupe({
        type: "history", title: `budget note ${i}`, content: "budget review", importance: 3
      }).memory.id);
    }
    const before = (await h.service.searchMemories("budget", { mode: "keyword", topK: 5, recordRecall: false })).map((m) => m.id);
    assert.deepEqual(before, ids.slice().reverse());
    assert.equal((await h.service.searchMemories("budget", { mode: "keyword", topK: 5, recordRecall: false }))
      .some((m) => m.preference), false);
    // Weights all exactly 1.0 while the flag is on: same order, no decoration.
    h.service.setTagWeight({ tag: "budget", weight: 1.0, actor: "test" });
    h.config.memoryPreferenceEnabled = true;
    const after = (await h.service.searchMemories("budget", { mode: "keyword", topK: 5, recordRecall: false })).map((m) => m.id);
    assert.deepEqual(after, before);
    assert.equal((await h.service.searchMemories("budget", { mode: "keyword", topK: 5, recordRecall: false }))
      .some((m) => m.preference), false);
  } finally {
    h.close();
  }
});

test("enabled preference promotes a near-relevant candidate before the topK cut", async () => {
  const h = setup({});
  try {
    // The oldest row gets a tag at save time; later writes are newer. Legacy
    // order is newest-first, so the weighted row sits outside topK=1.
    const weightedId = h.service.saveWithDedupe({
      type: "history", title: "budget note weighted", content: "budget review",
      importance: 3, tags: ["close_person"]
    }).memory.id;
    const ids = [weightedId];
    for (let i = 0; i < 4; i++) {
      ids.push(h.service.saveWithDedupe({
        type: "history", title: `budget note ${i}`, content: "budget review", importance: 3
      }).memory.id);
    }
    h.service.setTagWeight({ tag: "close_person", weight: 1.6, actor: "test" });
    h.config.memoryPreferenceEnabled = true;
    const result = await h.service.searchMemories("budget", { mode: "keyword", topK: 1, recordRecall: false });
    assert.equal(result[0].id, weightedId);
    assert.equal(result[0].preference.factor, 1.6);
    assert.equal(result[0].preference.applied, true);
    h.config.memoryPreferenceEnabled = false;
    const legacy = await h.service.searchMemories("budget", { mode: "keyword", topK: 1, recordRecall: false });
    assert.equal(legacy[0].id, ids[4]);
  } finally {
    h.close();
  }
});

test("automatic injection honors type/importance gates and explains preference", () => {
  const h = setup({});
  try {
    const low = h.service.saveWithDedupe({
      type: "history", title: "budget old", content: "budget notes", importance: 2, tags: ["close"]
    }).memory;
    const high = h.service.saveWithDedupe({
      type: "history", title: "budget new", content: "budget notes", importance: 3
    }).memory;
    h.service.setTagWeight({ tag: "close", weight: 2, actor: "test" });
    h.config.memoryPreferenceEnabled = true;
    const picked = h.service.injectCandidates({ query: "budget", maxItems: 2, threshold: 3 });
    assert.equal(picked.some((m) => m.id === low.id), false, "importance gate still excludes the low row");
    assert.equal(picked.some((m) => m.id === high.id), true);
    // A weighted visible row carries an explanatory factor; the inactive row does not.
    const byId = new Map(picked.map((m) => [m.id, m]));
    if (byId.get(high.id)?.preference) {
      assert.equal(byId.get(high.id).preference.factor, 1);
    }
    const weightedVisible = h.service.injectCandidates({ query: "budget", maxItems: 2, threshold: 2 });
    const weighted = weightedVisible.find((m) => m.id === low.id);
    assert.ok(weighted?.preference, "weighted row explains its preference contribution");
    assert.equal(weighted.preference.factor, PREFERENCE_FACTOR_MAX);
  } finally {
    h.close();
  }
});
