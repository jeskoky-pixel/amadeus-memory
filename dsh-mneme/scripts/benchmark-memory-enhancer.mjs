// Reproducible synthetic benchmark for the Amadeus memory enhancer.
//
// Baseline source lives in a checkout of the import commit, e.g.:
//   git archive 13e6520 dsh-mneme | tar -x -C .benchmark
//   node scripts/benchmark-memory-enhancer.mjs --baseline .benchmark/dsh-mneme
//
// The script seeds the *same* synthetic fixture into two independent SQLite
// files, runs the same query set, and reports Recall@K / MRR, p50/p95 latency,
// DB size and heap delta. No real memory, chat or account data is used.
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

async function runMode(label, pkg, configFactory, { runs, iterations }) {
  const dir = mkdtempSync(join(tmpdir(), `mneme-bench-${label}-`));
  const dbPath = join(dir, "memory.db");
  const heapBefore = process.memoryUsage().heapUsed;
  const config = configFactory();
  const store = pkg.createStore(dbPath);
  const service = pkg.createService({ store, mirror: null, config });
  const { byKey } = seedFixture(service, store);
  if (label === "implementation") {
    service.setTagWeight({ tag: "person:close", weight: 2, actor: "bench" });
    service.setTagWeight({ tag: "event:self_action", weight: 1.8, actor: "bench" });
    service.setTagWeight({ tag: "group:chatter", weight: 0.5, actor: "bench" });
    service.setTagWeight({ tag: "noise:high", weight: 2, actor: "bench" });
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
  // Practical DB cost: one representative LIKE scan and the on-disk footprint.
  const dbProbe = [];
  for (let i = 0; i < 30; i++) {
    const started = process.hrtime.bigint();
    store.search("birthday", { limit: 20 });
    dbProbe.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  let dbBytes = 0;
  try { dbBytes = statSync(dbPath).size; } catch { /* WAL may own it */ }
  const heapDelta = process.memoryUsage().heapUsed - heapBefore;
  store.close();
  rmSync(dir, { recursive: true, force: true });
  return {
    mode: label,
    retrieval: {
      recall_at_5: metrics.recall_at_k,
      precision_at_5: metrics.precision_at_k,
      mrr: metrics.mrr,
      per_query: metrics.per_query.map((row) => ({
        query: row.query,
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
    heap_delta_bytes: heapDelta,
    heap_after_seed_bytes: heapAfterSeed,
    background_llm_calls: 0
  };
}

const baselineRoot = arg("--baseline", "");
if (!baselineRoot) {
  console.error("usage: node scripts/benchmark-memory-enhancer.mjs --baseline <baseline-package-root> [--runs 3] [--iterations 30] [--json out.json]");
  process.exit(2);
}
if (!existsSync(join(baselineRoot, "src", "service.js"))) {
  console.error(`baseline src not found under ${baselineRoot}`);
  process.exit(2);
}
const runs = Math.max(1, Number(arg("--runs", "3")) || 3);
const iterations = Math.max(1, Number(arg("--iterations", "30")) || 30);
const current = await loadPackage(join(process.cwd()));
const baseline = await loadPackage(baselineRoot);

const report = {
  generated_at: new Date().toISOString(),
  fixture: "synthetic: 4 old important, 3 close birthday, 3 close weekend, 6 self actions, 28 group chatter, 6 irrelevant high-weight; 50 memories",
  runs,
  iterations,
  background_llm_calls_note: "No provider, extractor, dream or summarize hook is installed in the benchmark; both modes make 0 background LLM calls.",
  modes: []
};
for (let i = 0; i < runs; i++) {
  // Alternate order so neither side always benefits from a warm process.
  const order = i % 2 === 0 ? ["baseline", "implementation"] : ["implementation", "baseline"];
  for (const mode of order) {
    const result = mode === "baseline"
      ? await runMode("baseline", baseline, () => ({}), { runs, iterations })
      : await runMode("implementation", current, () => ({ memoryPreferenceEnabled: true }), { runs, iterations });
    report.modes.push({ run: i + 1, ...result });
  }
}
const baselineRuns = report.modes.filter((row) => row.mode === "baseline");
const implRuns = report.modes.filter((row) => row.mode === "implementation");
const mean = (rows, get) => rows.reduce((sum, row) => sum + get(row), 0) / (rows.length || 1);
report.summary = {
  baseline_recall_at_5: Number(mean(baselineRuns, (r) => r.retrieval.recall_at_5).toFixed(4)),
  implementation_recall_at_5: Number(mean(implRuns, (r) => r.retrieval.recall_at_5).toFixed(4)),
  baseline_mrr: Number(mean(baselineRuns, (r) => r.retrieval.mrr).toFixed(4)),
  implementation_mrr: Number(mean(implRuns, (r) => r.retrieval.mrr).toFixed(4)),
  baseline_p50_ms: Number(mean(baselineRuns, (r) => r.latency_ms.p50).toFixed(3)),
  implementation_p50_ms: Number(mean(implRuns, (r) => r.latency_ms.p50).toFixed(3)),
  baseline_p95_ms: Number(mean(baselineRuns, (r) => r.latency_ms.p95).toFixed(3)),
  implementation_p95_ms: Number(mean(implRuns, (r) => r.latency_ms.p95).toFixed(3)),
  baseline_db_bytes: Math.round(mean(baselineRuns, (r) => r.db_bytes)),
  implementation_db_bytes: Math.round(mean(implRuns, (r) => r.db_bytes)),
  baseline_heap_delta_bytes: Math.round(mean(baselineRuns, (r) => r.heap_delta_bytes)),
  implementation_heap_delta_bytes: Math.round(mean(implRuns, (r) => r.heap_delta_bytes)),
  background_llm_calls: 0
};
const jsonPath = arg("--json", "");
if (jsonPath) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  console.log(`wrote ${jsonPath}`);
}
console.log(JSON.stringify(report.summary, null, 2));
