// Synthetic retrieval fixture for the Amadeus memory enhancer.
//
// No real memory, chat, account or platform identifier is used here. The
// synthetic QQ group number is clearly fake (90000101). The fixture models:
// - frequent casual group chatter (low-value, high volume)
// - sparse close-person events (the memories a user actually wants recalled)
// - own actions written through the trusted-intake tag vocabulary
// - old important memories
// - irrelevant memories that carry a high preference weight, to exercise the
//   relevance floor.
export const FIXTURE_GROUP = "QQ群90000101";
export const FIXTURE_PERSON = "Aster";

export const FIXTURE_QUERIES = [
  {
    query: "birthday dinner Aster",
    expected: [
      "close-birthday-0", "close-birthday-1", "close-birthday-2",
      "old-birthday-0", "old-birthday-1", "old-birthday-2", "old-birthday-3"
    ]
  },
  {
    query: "workshop supplies ordered",
    expected: ["self-action-0", "self-action-1", "self-action-2", "self-action-3", "self-action-4", "self-action-5"]
  },
  {
    query: "weekend plan",
    expected: ["close-weekend-0", "close-weekend-1", "close-weekend-2"]
  }
];

export function fixtureMemories() {
  const rows = [];
  // Old important memories are inserted first (they are the "old" tier).
  for (let i = 0; i < 4; i++) {
    rows.push({
      key: `old-birthday-${i}`,
      title: `Aster birthday dinner archive ${i}`,
      content: `Old important event: Aster birthday dinner, year archive ${i}.`,
      type: "history", importance: 5, tags: ["person:close", "archive:old"]
    });
  }
  for (let i = 0; i < 3; i++) {
    rows.push({
      key: `close-birthday-${i}`,
      title: `Aster birthday dinner plan ${i}`,
      content: `Close-person event: dinner with Aster for the birthday plan ${i}.`,
      type: "history", importance: 4, tags: ["person:close", "event:direct_interaction"]
    });
  }
  for (let i = 0; i < 3; i++) {
    rows.push({
      key: `close-weekend-${i}`,
      title: `Weekend plan with Aster ${i}`,
      content: `Close-person weekend plan with Aster, dinner and a walk ${i}.`,
      type: "history", importance: 4, tags: ["person:close"]
    });
  }
  for (let i = 0; i < 6; i++) {
    rows.push({
      key: `self-action-${i}`,
      title: `Ordered workshop supplies ${i}`,
      content: `Own action: ordered workshop supplies batch ${i}; supplies arrived.`,
      type: "history", importance: 3, tags: ["event:self_action"]
    });
  }
  // Lots of casual chatter: low importance, deliberately lexical (short and
  // repeated query terms) so BM25 ranks it above the sparse close-person
  // events. This is the failure mode preferences must counter.
  for (let i = 0; i < 28; i++) {
    rows.push({
      key: `chatter-${i}`,
      title: `Group chatter ${i}`,
      content: `${FIXTURE_GROUP}: birthday dinner Aster, weekend plan, workshop supplies ordered, chatter ${i}.`,
      type: "history", importance: 1, tags: ["group:chatter"]
    });
  }
  // Deliberately high-weight but irrelevant. Some share a query token, so they
  // enter the candidate pool and prove the relevance floor is doing work.
  for (let i = 0; i < 6; i++) {
    rows.push({
      key: `noise-${i}`,
      title: `Quarterly invoice reconciliation ${i}`,
      content: `Irrelevant high-weight memory: invoice reconciliation plan for quarter ${i}.`,
      type: "project", importance: 2, tags: ["noise:high"]
    });
  }
  return rows;
}

/**
 * Seed a fixture through the public service save path. Returns
 * { byKey, entity } where byKey maps fixture keys to memory ids and entity is
 * the synthetic close-person entity id.
 *
 * `trustedEvents` uses the trusted intake channel for fixture rows carrying
 * event:* tags so the implementation arms have genuine provenance instead of
 * unbacked tags (the baseline arm cannot, and keeps its historical behavior).
 */
export function seedFixture(service, store, { trustedEvents = false } = {}) {
  const byKey = new Map();
  const kindForTag = {
    "event:self_action": {
      kind: "self_action", participation: "agent", trust_source: "system"
    },
    "event:direct_interaction": {
      kind: "direct_interaction", participation: "both", trust_source: "verified_user"
    }
  };
  for (const row of fixtureMemories()) {
    const eventTag = row.tags.find((tag) => kindForTag[tag]);
    let saved;
    if (trustedEvents && eventTag && typeof service.submitTrustedMemory === "function") {
      saved = service.submitTrustedMemory({
        kind: kindForTag[eventTag].kind,
        status: "completed",
        participation: kindForTag[eventTag].participation,
        trust_source: kindForTag[eventTag].trust_source,
        actor: "synthetic-fixture",
        title: row.title,
        content: row.content,
        type: row.type,
        importance: row.importance,
        scope: { agent_scope: "amadeus", workspace_scope: "life-test" },
        tags: row.tags.filter((tag) => tag !== eventTag),
        evidence: [{ kind: "synthetic", value: row.key }]
      });
    } else {
      saved = service.saveWithDedupe({
        type: row.type,
        title: row.title,
        content: row.content,
        importance: row.importance,
        tags: row.tags,
        source: "synthetic_fixture"
      });
    }
    byKey.set(row.key, saved.memory.id);
  }
  const person = store.createEntity({ name: FIXTURE_PERSON, type: "person" });
  const group = store.createEntity({ name: FIXTURE_GROUP, type: "group" });
  for (const [key, memoryId] of byKey) {
    if (key.startsWith("close-") || key.startsWith("old-birthday")) {
      store.saveAttr({
        entity_id: person.id, attr_key: "relation", attr_value: "close",
        memory_id: memoryId, source: "synthetic_fixture"
      });
    }
    if (key.startsWith("chatter-")) {
      store.saveAttr({
        entity_id: group.id, attr_key: "kind", attr_value: "casual_chatter",
        memory_id: memoryId, source: "synthetic_fixture"
      });
    }
  }
  store.saveRelation({
    from_entity: person.id, to_entity: group.id, relation_type: "related_to",
    memory_id: byKey.get("close-birthday-0"), source: "synthetic_fixture", weight: 0.6
  });
  return { byKey, person, group };
}

export function expectedIdsFor(byKey) {
  return FIXTURE_QUERIES.map((entry) => ({
    query: entry.query,
    expectedIds: entry.expected.map((key) => byKey.get(key)).filter(Boolean)
  }));
}

export function metricsFor(actualIds, expectedIds) {
  const expected = new Set(expectedIds);
  const relevant = actualIds.filter((id) => expected.has(id)).length;
  let rr = 0;
  for (let i = 0; i < actualIds.length; i++) {
    if (expected.has(actualIds[i])) { rr = 1 / (i + 1); break; }
  }
  return {
    recall: expected.size ? relevant / expected.size : 0,
    precision: actualIds.length ? relevant / actualIds.length : 0,
    mrr: rr,
    hit_count: relevant
  };
}

/**
 * Run the fixture query set through the real service. The caller controls
 * config.flags and preference weights; this function only uses public service
 * APIs present in both the import baseline and the implementation.
 */
export async function evaluateFixture(service, byKey, { topK = 5, mode = "auto" } = {}) {
  const cases = expectedIdsFor(byKey);
  const perQuery = [];
  for (const entry of cases) {
    const rows = await service.searchMemories(entry.query, { mode, topK, recordRecall: false });
    const actualIds = rows.map((row) => row.id);
    perQuery.push({
      query: entry.query,
      expected: entry.expectedIds.length,
      expected_ids: entry.expectedIds,
      ranks: entry.expectedIds.map((id) => {
        const index = actualIds.indexOf(id);
        return { id, rank: index >= 0 ? index + 1 : null };
      }),
      actual: actualIds,
      metrics: metricsFor(actualIds, entry.expectedIds),
      preferences: rows.filter((row) => row.preference).map((row) => ({ id: row.id, factor: row.preference.factor }))
    });
  }
  const avg = (key) => perQuery.reduce((sum, row) => sum + row.metrics[key], 0) / (perQuery.length || 1);
  return {
    topK,
    mode,
    recall_at_k: Number(avg("recall").toFixed(4)),
    precision_at_k: Number(avg("precision").toFixed(4)),
    mrr: Number(avg("mrr").toFixed(4)),
    per_query: perQuery
  };
}
