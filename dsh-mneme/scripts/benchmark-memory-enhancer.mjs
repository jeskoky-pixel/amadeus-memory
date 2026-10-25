// Reproducible synthetic preference-ablation benchmark for the Amadeus memory
// enhancer.
//
// Arms:
//   A: original import baseline (no enhancer)
//   B: implementation with the same enlarged candidate pool but neutral weights
//   C: same pool + tag weights only
//   D: same pool + tag + canonical-entity weights
//   all1: flag on but every weight exactly 1.0 (off-equivalent control)
//
// B uses a test-only config gate (`__preferenceAblationPoolOnly`) that is not in
// the config schema/feature flags and defaults false, so product behavior is
// unchanged. All arm identifiers/content are synthetic.
import { mkdtempSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { seedFixture, evaluateFixture } from "./memory-enhancer-fixture.mjs";

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

async function loadPackage(root) {
  const base = pathToFileURL(resolve(root)).href;
  const store = await import(`${base}/src/store.js`);
  const service = await import(`${base}/src/service.js`);
  return { createStore: store.createStore, createService: service.createService };
}

const TAG_WEIGHTS = [
  ["person:close", 2], ["event:self_action", 1.8],
  ["group:chatter", 0.5], ["noise:high", 2]
];

function armSpec(id, label, pkg, config, weights, trustedEvents = false) {
  return { id, label, pkg, config: config ?? {}, weights: weights ?? null, trustedEvents };
}

async function runArm(arm, { iterations }) {
  const dir = mkdtempSync(join(tmpdir(), `mneme-ablation-${arm.id}-`));
  const dbPath = join(dir, "memory.db");
  const heapBefore = process.memoryUsage().heapUsed;
  const store = arm.pkg.createStore(dbPath);
  const service = arm.pkg.createService({ store, mirror: null, config: arm.config });
  try {
    const { byKey } = seedFixture(service, store, { trustedEvents: arm.trustedEvents });
    if (arm.weights === "ones") {
      for (const [tag] of TAG_WEIGHTS) service.setTagWeight({ tag, weight: 1, actor: "bench" });
      service.setEntityWeight({ entity_id: store.findEntityByName("Aster").id, weight: 1, actor: "bench" });
    } else if (arm.weights === "tags") {
      for (const [tag, weight] of TAG_WEIGHTS) service.setTagWeight({ tag, weight, actor: "bench" });
    } else if (arm.weights === "tags_entity") {
      for (const [tag, weight] of TAG_WEIGHTS) service.setTagWeight({ tag, weight, actor: "bench" });
      service.setEntityWeight({ entity_id: store.findEntityByName("Aster").id, weight: 1.5, actor: "bench" });
    }
    const heapAfterSeed = process.memoryUsage().heapUsed - heapBefore;
    const metrics = await evaluateFixture(service, byKey, { topK: 5 });
    const latencies = [];
    for (let i = 0; i < iterations; i++) {
      for (const query of ["birthday dinner Aster", "workshop supplies ordered", "weekend plan"]) {
        const started = process.hrtime.bigint();
        await service.searchMemories(query, { mode: "auto", topK: 5, recordRecall: false });
        latencies.push(Number(process.hrtime.bigint() - started) / 1e6);
      }
    }
    const dbProbe = [];
    for (let i = 0; i < 30; i++) {
      const started = process.hrtime.bigint();
      store.search("birthday", { limit: 20 });
      dbProbe.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    let dbBytes = 0;
    try { dbBytes = statSync(dbPath).size; } catch { /* WAL may own it */ }
    return {
      arm: arm.id,
      label: arm.label,
      retrieval: {
        recall_at_5: metrics.recall_at_k,
        precision_at_5: metrics.precision_at_k,
        mrr: metrics.mrr,
        per_query: metrics.per_query.map((row) => ({
          query: row.query,
          expected_ids: row.expected_ids,
          ranks: row.ranks,
          metrics: row.metrics,
          preference_rows: row.preferences.length
        }))
      },
      latency_ms: {
        p50: Number(percentile(latencies, 50).toFixed(3)),
        p95: Number(percentile(latencies, 95).toFixed(3)),
        samples: latencies.length
      },
      db_search_ms: {
        p50: Number(percentile(dbProbe, 50).toFixed(3)),
        p95: Number(percentile(dbProbe, 95).toFixed(3))
      },
      db_bytes: dbBytes,
      heap_delta_bytes: process.memoryUsage().heapUsed - heapBefore,
      heap_after_seed_bytes: heapAfterSeed,
      background_llm_calls: 0
    };
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const baselineRoot = arg("--baseline", "");
if (!baselineRoot) {
  console.error("usage: node scripts/benchmark-memory-enhancer.mjs --baseline <baseline-package-root> [--runs 3] [--iterations 20] [--json out.json]");
  process.exit(2);
}
if (!existsSync(join(baselineRoot, "src", "service.js"))) {
  console.error(`baseline src not found under ${baselineRoot}`);
  process.exit(2);
}
const runs = Math.max(1, Number(arg("--runs", "3")) || 3);
const iterations = Math.max(1, Number(arg("--iterations", "20")) || 20);
const current = await loadPackage(join(process.cwd()));
const baseline = await loadPackage(baselineRoot);

const arms = [
  armSpec("A", "original_baseline", baseline, {}, null),
  armSpec("B", "pool_only_neutral", current, { __preferenceAblationPoolOnly: true, trustedIntakeEnabled: true }, null, true),
  armSpec("C", "tag_weights_only", current, { memoryPreferenceEnabled: true, trustedIntakeEnabled: true }, "tags", true),
  armSpec("D", "tag_plus_entity_weights", current, { memoryPreferenceEnabled: true, trustedIntakeEnabled: true }, "tags_entity", true),
  armSpec("all1", "all_1_0_control", current, { memoryPreferenceEnabled: true, trustedIntakeEnabled: true }, "ones", true)
];

const report = {
  generated_at: new Date().toISOString(),
  fixture: "synthetic: 4 old important, 3 close birthday, 3 close weekend, 6 self actions, 28 group chatter, 6 irrelevant high-weight; 50 memories",
  queries: ["birthday dinner Aster", "workshop supplies ordered", "weekend plan"],
  top_k: 5,
  runs,
  iterations,
  arms: arms.map((arm) => ({ id: arm.id, label: arm.label })),
  background_llm_calls_note: "No provider, extractor, dream or summarize hook is installed; every arm makes 0 background LLM calls.",
  samples: []
};
for (let run = 1; run <= runs; run++) {
  // Rotate the order deterministically so no arm always gets the warm process.
  const ordered = [...arms.slice((run - 1) % arms.length), ...arms.slice(0, (run - 1) % arms.length)];
  for (const arm of ordered) {
    report.samples.push({ run, ...(await runArm(arm, { iterations })) });
  }
}
const mean = (rows, get) => rows.reduce((sum, row) => sum + get(row), 0) / (rows.length || 1);
const byArm = (id) => report.samples.filter((row) => row.arm === id);
report.summary = {};
for (const arm of arms) {
  const rows = byArm(arm.id);
  report.summary[arm.id] = {
    label: arm.label,
    recall_at_5: Number(mean(rows, (r) => r.retrieval.recall_at_5).toFixed(4)),
    mrr: Number(mean(rows, (r) => r.retrieval.mrr).toFixed(4)),
    p50_ms: Number(mean(rows, (r) => r.latency_ms.p50).toFixed(3)),
    p95_ms: Number(mean(rows, (r) => r.latency_ms.p95).toFixed(3)),
    db_bytes: Math.round(mean(rows, (r) => r.db_bytes)),
    heap_delta_bytes: Math.round(mean(rows, (r) => r.heap_delta_bytes)),
    background_llm_calls: 0,
    per_query_ranks_run_1: (rows[0]?.retrieval.per_query ?? []).map((row) => ({
      query: row.query,
      ranks: row.ranks
    }))
  };
}
report.summary.baseline_recall_at_5 = report.summary.A.recall_at_5;
report.summary.implementation_recall_at_5 = report.summary.D.recall_at_5;
report.summary.baseline_mrr = report.summary.A.mrr;
report.summary.implementation_mrr = report.summary.D.mrr;
const jsonPath = arg("--json", "");
if (jsonPath) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  console.log(`wrote ${jsonPath}`);
}
console.log(JSON.stringify(report.summary, null, 2));
