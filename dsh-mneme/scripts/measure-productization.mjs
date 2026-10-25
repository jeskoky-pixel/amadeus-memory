// Isolated, synthetic productization measurements. Never uses the default
// ~/.dsh/memory path: the resolved directory must be under the package
// .test-tmp directory, and the script prints JSON only (no data files remain).
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../src/store.js";
import { createService } from "../src/service.js";
import { createSettings } from "../src/settings.js";
import { createInjector } from "../src/inject.js";
import { createBackup, preflightBackup } from "../src/backup.js";
import { assertIsolatedMemoryDir } from "../src/qa-guard.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", ".test-tmp");
mkdirSync(root, { recursive: true });
const dir = assertIsolatedMemoryDir(join(root, `measure-${process.pid}-${Date.now()}`), { qaRoot: root });

const config = {
  language: "zh", autoInject: true, autoSummarize: false, autoDream: false,
  sleepModeEnabled: false, entityExtractionEnabled: false, memoryPreferenceEnabled: false,
  trustedIntakeEnabled: false, rerankEnabled: false, embedProvider: "openai",
  maxInjectedItems: 5, importanceThreshold: 1, injectContentMaxChars: 300,
  hotMemoryEnabled: false, injectGuidanceEnabled: false,
  memoryQualityFilter: { enabled: true }, llmAudit: { enabled: true }
};
const store = createStore(join(dir, "memory.db"));
const service = createService({ store, mirror: null, config });
const settings = createSettings(store.db);
try {
  for (let i = 0; i < 500; i += 1) {
    service.saveWithDedupe({
      type: i % 3 === 0 ? "project" : i % 3 === 1 ? "decision" : "constraint",
      title: `Synthetic memory ${i}`,
      content: `Synthetic productization measurement row ${i}. `.repeat(4),
      importance: 4,
      tags: ["synthetic", `batch-${i % 5}`],
      source: "measurement"
    });
  }
  const time = (fn, rounds = 50) => {
    const started = process.hrtime.bigint();
    for (let i = 0; i < rounds; i += 1) fn(i);
    return Number(process.hrtime.bigint() - started) / 1e6 / rounds;
  };
  const listMs = time(() => service.list({ limit: 20 }), 50);
  const searchMs = time(() => service.search("synthetic measurement", { limit: 20 }), 50);
  const backupStarted = process.hrtime.bigint();
  const backup = createBackup({ store, memoryDir: dir });
  const backupMs = Number(process.hrtime.bigint() - backupStarted) / 1e6;
  const preflightStarted = process.hrtime.bigint();
  const checked = preflightBackup(dir, backup.name);
  const preflightMs = Number(process.hrtime.bigint() - preflightStarted) / 1e6;

  let renderText = "";
  const ctx = {
    logger: { warn() {}, info() {} },
    systemPrompt: {
      context(spec) { if (spec.name === "memory") renderText = spec.text; return () => {}; },
      section() { return () => {}; }
    }
  };
  const dispose = createInjector(ctx, service, settings, config, null);
  const renderCtx = { agent: { session: { id: "measurement-session" } } };
  const renderStarted = process.hrtime.bigint();
  let chars = 0;
  for (let i = 0; i < 50; i += 1) chars = renderText(renderCtx).length;
  const renderMs = Number(process.hrtime.bigint() - renderStarted) / 1e6 / 50;
  dispose();
  console.log(JSON.stringify({
    memories: store.count(),
    list_limit_20_ms: Number(listMs.toFixed(3)),
    keyword_search_limit_20_ms: Number(searchMs.toFixed(3)),
    backup_ms: Number(backupMs.toFixed(3)),
    backup_bytes: checked.bytes,
    backup_preflight_ms: Number(preflightMs.toFixed(3)),
    injection_render_ms: Number(renderMs.toFixed(3)),
    injection_chars: chars,
    injection_approx_tokens_chars_div_4: Math.ceil(chars / 4),
    note: "synthetic SQLite data in .test-tmp; no remote model/embedding request"
  }, null, 2));
} finally {
  try { store.db.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
