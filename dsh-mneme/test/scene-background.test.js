import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createVectorIndex } from "../src/vector-index.js";
import { createDreamScheduler, recordScopedDreamBaseline } from "../src/dream.js";
import { runSleep } from "../src/dream/sleep.js";
import { runWithSceneJob, LEGACY_SCENE_JOB, scopedSleepOutcome } from "../src/scene-job.js";
import { configureScene } from "../src/scene.js";
import { mockCtx, sessionDecisions } from "./helpers/dream-mock.js";

const A = "qq:group:bot:a";
const B = "qq:group:bot:b";

function setup() {
  const store = createStore(":memory:");
  const service = createService({ store, mirror: null, config: {} });
  return { store, service };
}

function seed(service, scene, title, content, type = "project") {
  return runWithSceneJob(scene, () => service.saveWithDedupe({ type, title, content, importance: 3 }).memory);
}

test("Dream job reads, prompts, summaries and audits only its own Scene", async () => {
  const { store, service } = setup();
  const a1 = seed(service, A, "群 A 部署", "群 A 的部署细节 shared");
  const a2 = seed(service, A, "群 A 端口", "群 A 的端口是 22 shared");
  const b1 = seed(service, B, "群 B 秘密", "群 B 的机密内容 SECRET_B");
  const prompts = [];
  const ctx = mockCtx({
    onConsolidation: (text) => {
      prompts.push(text);
      return sessionDecisions(text);
    }
  });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  const result = await runWithSceneJob(A, () => dream.runDream(ctx, service, {
    dreamProvider: "mock", dreamModel: "mock-model", dreamSummaryEnabled: true
  }));
  assert.equal(result.ok, true);
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].includes("群 A 部署") && prompts[0].includes("群 A 端口"));
  assert.equal(prompts[0].includes("SECRET_B"), false, "B must never enter A's LLM input");
  const summary = store.all().find((m) => m.type === "summary");
  assert.ok(summary, "summary created");
  assert.equal(summary.scene_scope, A, "generated summary inherits the job Scene");
  assert.equal(store.getById(b1.id).scene_scope, B, "B row untouched");
  assert.equal(store.all().filter((m) => m.type === "summary" && m.scene_scope === B).length, 0);
  assert.equal(runWithSceneJob(A, () => service.search("SECRET_B")).length, 0, "search cannot cross Scene");
  assert.equal(runWithSceneJob(A, () => service.search("群 A 部署")).length >= 1, true);
  const run = store.listDreamRuns({ limit: 1 })[0];
  assert.equal(run.scene_scope, A, "audit row names the Scene");
  assert.equal(run.store_count, undefined, "scoped run must not advance the global baseline");
});

test("legacy job isolates null-scene rows from tagged Scenes", async () => {
  const { store, service } = setup();
  seed(service, A, "群 A 私有", "SCENE_A_SECRET");
  seed(service, LEGACY_SCENE_JOB, "旧库兼容", "LEGACY_ONLY");
  const prompts = [];
  const ctx = mockCtx({ onConsolidation: (text) => { prompts.push(text); return sessionDecisions(text); } });
  const dream = createDreamScheduler({ thresholdCount: 1, thresholdChars: 0, delayMs: 0 });
  await runWithSceneJob(LEGACY_SCENE_JOB, () => dream.runDream(ctx, service, {
    dreamProvider: "mock", dreamModel: "mock-model", dreamSummaryEnabled: true
  }));
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].includes("旧库兼容"));
  assert.equal(prompts[0].includes("SCENE_A_SECRET"), false);
  const summary = store.all().find((m) => m.type === "summary");
  assert.equal(summary.scene_scope ?? null, null, "legacy summary stays legacy");
});

test("job context does not leak after completion or rejection", async () => {  const { store, service } = setup();
  const a = seed(service, A, "A 行", "A body");
  const b = seed(service, B, "B 行", "B body");
  assert.equal(service.all().length, 2, "unscoped read sees both before any job");
  await runWithSceneJob(A, async () => {
    assert.equal(service.all().length, 1);
    assert.equal(service.getById(b.id), undefined);
  });
  assert.equal(service.all().length, 2, "scope is gone after the job returns");
  assert.throws(() => runWithSceneJob(A, () => { throw new Error("abort"); }), /abort/);
  assert.equal(service.all().length, 2, "scope is gone after a job throws");
  assert.equal(service.getById(a.id).scene_scope, A);
});

test("job writes are stamped and cross-Scene decision targets are rejected", async () => {  const { store, service } = setup();
  const a = seed(service, A, "A 行", "A body");
  const b = seed(service, B, "B 行", "B body");
  const forged = await runWithSceneJob(A, () => service.saveWithDedupe({
    type: "history", title: "伪造来源", content: "ordinary caller cannot choose scene", scene_scope: B
  }).memory);
  assert.equal(forged.scene_scope, A, "job Scene wins over call-site scene_scope");
  assert.throws(
    () => runWithSceneJob(A, () => service.update(b.id, { title: "hijack" })),
    /not found in scene job/
  );
  assert.throws(
    () => runWithSceneJob(A, () => service.setArchived(b.id, true)),
    /SCENE_JOB_MISMATCH/
  );
  assert.equal(store.getById(b.id).title, "B 行");
  assert.equal(store.getById(b.id).archived, false);
  assert.equal(store.getById(a.id).scene_scope, A);
});

test("Sleep job excludes other Scenes from conflict/pattern prompts and writes", async () => {
  const { store, service } = setup();
  const vectorIndex = createVectorIndex({ store });
  const embedder = {
    embedSingle: async () => [1, 0, 0],
    embed: async (texts) => texts.map(() => [1, 0, 0]),
    schedule: () => {},
    modelHash: "mock#1",
    dimension: 3
  };
  service.setEmbedder(embedder);
  service.setVectorIndex(vectorIndex);
  const a1 = seed(service, A, "群 A 部署一", "群 A 的部署细节");
  const a2 = seed(service, A, "群 A 部署二", "群 A 的部署细节副本");
  const b1 = seed(service, B, "群 B 秘密一", "群 B 的机密 SECRET_B");
  const b2 = seed(service, B, "群 B 秘密二", "群 B 的机密 SECRET_B");
  const prompts = [];
  const ctx = {
    logger: { warn: () => {} },
    agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "mock-model" }) },
    llm: {
      async *stream(options) {
        const text = (options.messages ?? []).map((m) => m.content?.[0]?.text ?? m.content ?? "").join("\n");
        prompts.push(text);
        yield { type: "text-delta", text: "[]" };
        yield { type: "finish", reason: { kind: "stop" } };
      }
    }
  };
  const result = await runWithSceneJob(A, () => runSleep(ctx, service, {
    sleepModeEnabled: true, sleepActionSet: "conflict", sleepPatternMinMemories: 1,
    dreamProvider: "mock", dreamModel: "mock-model", sleepConflictStrictness: "normal"
  }, ctx.logger, { embedder, vectorIndex }, null));
  assert.ok(result && ["ok", "noop", "degraded"].includes(result.status), JSON.stringify(result));
  assert.ok(prompts.length >= 1, "Sleep must reach at least one LLM phase");
  assert.equal(prompts.some((p) => p.includes("SECRET_B")), false, "B must never enter A's Sleep prompts");
  assert.equal(store.getById(b1.id).archived, false);
  assert.equal(store.getById(b2.id).archived, false);
  assert.equal(store.getById(a1.id).scene_scope, A);
  assert.equal(store.getById(a2.id).scene_scope, A);
  const run = store.listDreamRuns({ limit: 1 })[0];
  assert.equal(run.run_type, "sleep");
  assert.equal(run.scene_scope, A);
});

test("job filters graph candidates and relation evidence before writes", () => {  const { store, service } = setup();
  const b = seed(service, B, "群 B 实体源", "群 B 的机密实体内容");
  const other = seed(service, B, "群 B 伙伴", "群 B 的伙伴内容");
  const e1 = store.createEntity({ name: "B秘密实体", type: "person" });
  const e2 = store.createEntity({ name: "B伙伴实体", type: "person" });
  store.saveAttr({ entity_id: e1.id, attr_key: "secret", attr_value: "B值", memory_id: b.id });
  store.saveRelation({ from_entity: e1.id, to_entity: e2.id, relation_type: "related_to", memory_id: b.id });
  runWithSceneJob(A, () => {
    assert.equal(service.listEntities({}).some((e) => e.id === e1.id || e.id === e2.id), false);
    assert.deepEqual(service.getRelations(e1.id), []);
    assert.deepEqual(service.getCurrentAttrs(e1.id), []);
    assert.throws(
      () => service.saveRelation({ from_entity: e1.id, to_entity: e2.id, relation_type: "related_to", memory_id: b.id }),
      /SCENE_JOB_MISMATCH/
    );
    assert.throws(
      () => service.saveConflictPending({ run_id: "r", memory_a: b.id, memory_b: other.id, reason: "x" }),
      /SCENE_JOB_MISMATCH/
    );
  });
});

test("strict scene policy accepts job-only writes for the matching Scene", () => {  const { store, service } = setup();
  const a = seed(service, A, "A 行", "A body");
  const b = seed(service, B, "B 行", "B body");
  configureScene({ enabled: true, strictQQ: true, hostContract: false });
  try {
    runWithSceneJob(A, () => service.update(a.id, { title: "A 更新" }));
    assert.equal(store.getById(a.id).title, "A 更新");
    assert.throws(() => runWithSceneJob(A, () => service.update(b.id, { title: "B 更新" })), /not found/);
    assert.equal(store.getById(b.id).title, "B 行");
  } finally {
    configureScene({ enabled: false, strictQQ: false, hostContract: false });
  }
});

test("canonical group visibility checks all member IDs, not only the canonical one", () => {
  const { store, service } = setup();
  const a = seed(service, A, "A 合并源", "A canonical member evidence");
  const b = seed(service, B, "B 合并源", "B canonical member evidence");
  const canonical = store.createEntity({ name: "合并后实体", type: "person" });
  const member = store.createEntity({ name: "合并前成员", type: "person" });
  const report = service.identity.dryRunMerge({
    from_entity: member.id, to_entity: canonical.id, actor: "test"
  });
  assert.equal(report.blocked, false, JSON.stringify(report));
  service.identity.confirmMerge({ report_id: report.report_id, actor: "test" });
  const group = service.identity.groupForEntity(canonical.id);
  assert.equal(group.member_ids.includes(member.id), true, "fixture has a noncanonical member");
  store.saveAttr({ entity_id: member.id, attr_key: "k", attr_value: "a", memory_id: a.id });
  const external = store.createEntity({ name: "外部关联实体", type: "person" });
  store.saveRelation({
    from_entity: member.id, to_entity: external.id, relation_type: "related_to",
    memory_id: a.id, weight: 0.5
  });
  const bEntity = store.createEntity({ name: "B 独有实体", type: "person" });
  store.saveAttr({ entity_id: bEntity.id, attr_key: "k", attr_value: "b", memory_id: b.id });
  runWithSceneJob(A, () => {
    assert.equal(service.listEntities({ limit: 10 }).some((e) => e.id === canonical.id), true);
    assert.equal(service.listEntitiesPage({ limit: 10, offset: 0 }).items.some((e) => e.id === canonical.id), true);
    assert.equal(service.getCurrentAttrs(canonical.id).some((attr) => attr.memory_id === a.id), true);
    assert.equal(service.getRelations(canonical.id).length >= 1, true);
    assert.equal(service.getCurrentAttrs(bEntity.id).length, 0);
  });
  runWithSceneJob(B, () => {
    assert.equal(service.getCurrentAttrs(canonical.id).length, 0, "B-only member evidence must not leak into A group");
    assert.equal(service.getCurrentAttrs(bEntity.id).some((attr) => attr.memory_id === b.id), true);
  });
});

test("relation canonicalization happens after Scene filtering", () => {
  const { store, service } = setup();
  const a = seed(service, A, "A 源", "A relation source");
  const b = seed(service, B, "B 源", "B relation source");
  const e1 = store.createEntity({ name: "共同端点一", type: "person" });
  const e2 = store.createEntity({ name: "共同端点二", type: "person" });
  store.saveAttr({ entity_id: e1.id, attr_key: "k", attr_value: "a", memory_id: a.id });
  store.saveAttr({ entity_id: e2.id, attr_key: "k", attr_value: "a", memory_id: a.id });
  store.saveAttr({ entity_id: e1.id, attr_key: "k", attr_value: "b", memory_id: b.id });
  store.saveAttr({ entity_id: e2.id, attr_key: "k", attr_value: "b", memory_id: b.id });
  const edgeA = store.saveRelation({
    from_entity: e1.id, to_entity: e2.id, relation_type: "related_to",
    memory_id: a.id, weight: 0.3, source: "manual"
  });
  const edgeB = store.saveRelation({
    from_entity: e1.id, to_entity: e2.id, relation_type: "related_to",
    memory_id: b.id, weight: 0.9, source: "manual"
  });
  const aView = runWithSceneJob(A, () => service.getRelations(e1.id));
  const bView = runWithSceneJob(B, () => service.getRelations(e1.id));
  assert.equal(aView.length, 1, "same-Scene edge remains visible to orphan check");
  assert.deepEqual(aView[0].memory_ids ?? [aView[0].memory_id], [a.id]);
  assert.equal(aView[0].weight, 0.3);
  assert.deepEqual(aView[0].edge_ids ?? [aView[0].id], [edgeA.id]);
  assert.equal(JSON.stringify(aView).includes(edgeB.id), false);
  assert.equal(bView.length, 1);
  assert.deepEqual(bView[0].memory_ids ?? [bView[0].memory_id], [b.id]);
  assert.equal(bView[0].weight, 0.9);
  assert.deepEqual(bView[0].edge_ids ?? [bView[0].id], [edgeB.id]);
  assert.equal(JSON.stringify(bView).includes(edgeA.id), false);
});

test("entity pagination applies the Scene predicate before limit/offset", () => {
  const { store, service } = setup();
  const a = seed(service, A, "A 源", "A entity source");
  const b = seed(service, B, "B 源", "B entity source");
  for (const name of ["A1", "A2", "A3"]) {
    const e = store.createEntity({ name, type: "person" });
    store.saveAttr({ entity_id: e.id, attr_key: "k", attr_value: "a", memory_id: a.id });
  }
  for (const name of ["B1", "B2", "B3", "B4", "B5"]) {
    const e = store.createEntity({ name, type: "person" });
    store.saveAttr({ entity_id: e.id, attr_key: "k", attr_value: "b", memory_id: b.id });
  }
  const limited = runWithSceneJob(A, () => service.listEntities({ limit: 2 }));
  assert.equal(limited.length, 2);
  assert.ok(limited.every((entity) => /^A/.test(entity.name)));
  const page = runWithSceneJob(A, () => service.listEntitiesPage({ limit: 1, offset: 1 }));
  assert.equal(page.total, 3);
  assert.equal(page.items.length, 1);
  assert.equal(page.has_more, true);
  const last = runWithSceneJob(A, () => service.listEntitiesPage({ limit: 1, offset: 2 }));
  assert.equal(last.has_more, false);
});

test("real persisted scene_scope 'legacy' is distinct from the NULL legacy bucket", () => {
  const { store, service } = setup();
  const realLegacyName = seed(service, "legacy", "真实 legacy 场景", "persisted literal legacy");
  const nullLegacy = seed(service, LEGACY_SCENE_JOB, "NULL 场景", "persisted null legacy");
  assert.equal(realLegacyName.scene_scope, "legacy");
  assert.equal(nullLegacy.scene_scope, undefined);
  const real = runWithSceneJob("legacy", () => service.all());
  const nul = runWithSceneJob(LEGACY_SCENE_JOB, () => service.all());
  assert.deepEqual(real.map((row) => row.id), [realLegacyName.id]);
  assert.deepEqual(nul.map((row) => row.id), [nullLegacy.id]);
  const entity = store.createEntity({ name: "真实 legacy 实体", type: "person" });
  store.saveAttr({ entity_id: entity.id, attr_key: "k", attr_value: "v", memory_id: realLegacyName.id });
  assert.equal(runWithSceneJob("legacy", () => service.listEntities({})).some((e) => e.id === entity.id), true);
  assert.equal(runWithSceneJob(LEGACY_SCENE_JOB, () => service.listEntities({})).some((e) => e.id === entity.id), false);
  const scopes = store.listSceneScopes();
  assert.equal(scopes.some((row) => row.scope === "legacy" && row.null_scope === false), true);
  assert.equal(scopes.some((row) => row.scope === "legacy" && row.null_scope === true), true);
});

test("aborted scoped Sleep is reported as cancelled, not a completed success", () => {
  const controller = new AbortController();
  controller.abort();
  const outcome = scopedSleepOutcome({
    last: { ok: true, status: "ok" }, ok: true, processed: 1, total: 3, aborted: controller.signal.aborted
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.status, "aborted");
  assert.equal(outcome.processed, 1);
  assert.equal(outcome.total_scenes, 3);
  const complete = scopedSleepOutcome({ last: { ok: true }, ok: true, processed: 3, total: 3, aborted: false });
  assert.equal(complete.ok, true);
});

test("Dream scheduler routes onRun through service.enqueue like Sleep", async () => {
  const { store, service } = setup();
  seed(service, A, "A 并发", "queued dream body");
  const order = [];
  const original = service.enqueue.bind(service);
  service.enqueue = (fn) => {
    order.push("enqueue");
    return original(async () => { order.push("run"); return fn(); });
  };
  const dream = createDreamScheduler({
    thresholdCount: 1, thresholdChars: 0, delayMs: 0,
    onRun: async () => { order.push("onrun"); return { ok: true, baseline: { count: 1, chars: 1 } }; }
  });
  try {
    assert.equal(dream.maybeSchedule(service), true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(order, ["enqueue", "run", "onrun"]);
  } finally {
    await dream.dispose();
    store.close();
  }
});

test("successful scoped Dream persists a global baseline across restart; partial failure does not", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-mneme-scoped-baseline-"));
  const file = join(dir, "memory.db");
  try {
    let store = createStore(file);
    let service = createService({ store, mirror: null, config: {} });
    seed(service, A, "A1", "A body one");
    seed(service, A, "A2", "A body two");
    seed(service, B, "B1", "B body one");
    const before = store.listDreamRuns({ limit: 10 }).length;
    assert.equal(recordScopedDreamBaseline(store, service, {}, [
      { ok: true, runId: "run-a" }, { ok: false, runId: "run-b" }
    ]), null, "partial failure must not record a success baseline");
    assert.equal(store.listDreamRuns({ limit: 10 }).length, before);
    const baseline = recordScopedDreamBaseline(store, service, { dreamProvider: "mock", dreamModel: "mock-model" }, [
      { ok: true, runId: "run-a", applied: 1, summary: true },
      { ok: true, runId: "run-b", applied: 2, summary: false }
    ]);
    assert.deepEqual(baseline, { count: 3, chars: store.activeSize().chars });
    assert.deepEqual(store.lastDreamBaseline("auto"), baseline);
    const latest = store.listDreamRuns({ limit: 1 })[0];
    assert.equal(latest.scene_scope, undefined, "aggregate row is explicitly unscoped");
    assert.equal(latest.run_type, "auto");
    store.close();

    store = createStore(file);
    service = createService({ store, mirror: null, config: {} });
    assert.deepEqual(store.lastDreamBaseline("auto"), baseline, "baseline survives restart");
    assert.equal(store.listDreamRuns({ limit: 10 }).some((row) => row.scene_scope === "(aggregate)"), false);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
