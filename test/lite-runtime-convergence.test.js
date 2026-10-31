import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createStore } from "../src/store.js";
import { createSettings } from "../src/settings.js";
import { createScopedRuntimeConfig, needsSceneScopedBackgroundJobs } from "../src/index.js";

function staleFlagSettings() {
  const store = createStore(":memory:");
  const settings = createSettings(store.db);
  store.db.prepare("INSERT INTO user_settings (key, value) VALUES (?, ?)").run(
    "feature_flags",
    JSON.stringify({
      recentContextEnabled: true,
      trustedIntakeEnabled: true,
      autoDream: true
    })
  );
  return { store, settings };
}

test("lite background policy keeps the original Mneme path when no Scene rows exist", () => {
  assert.equal(needsSceneScopedBackgroundJobs({}), false);
  assert.equal(
    needsSceneScopedBackgroundJobs({ sceneIsolationEnabled: false, hasSceneScopedRows: false }),
    false,
    "a new Workspace with isolation off must not enumerate Scene buckets"
  );
});

test("tagged rows or explicit Scene isolation keep the per-Scene compatibility path", () => {
  assert.equal(
    needsSceneScopedBackgroundJobs({ hasSceneScopedRows: true }),
    true,
    "one tagged row is enough to require the scoped path"
  );
  assert.equal(
    needsSceneScopedBackgroundJobs({ sceneIsolationEnabled: true }),
    true,
    "explicit Scene isolation keeps its existing path"
  );
});

test("index wires direct Dream/Sleep for the lite path and scoped jobs for legacy data", () => {
  const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");
  // Direct original Mneme calls, guarded by the same live policy decision.
  assert.match(
    src,
    /async function runBackgroundDream\(\) \{\s*if \(unifiedRuntime\) return unifiedRuntime\.runSources\(\(\) => dream\.runDream\(ctx, service, runtimeCfg\)\);\s*if \(!sceneUnsafeDerivation\(\)\) return dream\.runDream\(ctx, service, runtimeCfg\);\s*return runScopedDreams\(\);/
  );
  assert.match(
    src,
    /async function runBackgroundSleep\(signal\) \{\s*if \(unifiedRuntime\) return unifiedRuntime\.runSources\(\(\) => runSleep\(ctx, service, runtimeCfg, ctx\.logger, \{ embedder, vectorIndex \}, signal\)\);\s*if \(!sceneUnsafeDerivation\(\)\) \{\s*return runSleep\(ctx, service, runtimeCfg, ctx\.logger, \{ embedder, vectorIndex \}, signal\);\s*\}\s*return runScopedSleep\(signal\);/
  );
  // The compatibility path still enumerates persisted buckets and uses the
  // Scene job scope for both jobs.
  assert.match(src, /function listBackgroundSceneScopes\(\)/);
  assert.match(src, /runWithSceneJob\(scope, \(\) => dream\.runDream\(ctx, service, runtimeCfg\)\)/);
  assert.match(src, /runWithSceneJob\(scope, \(\) => runSleep\(ctx, service, runtimeCfg, ctx\.logger, \{ embedder, vectorIndex \}, signal\)\)/);
  // Scheduler hooks and options are unchanged.
  assert.match(src, /service\.setDreamHook\(\(\) => dream\.maybeSchedule\(service\)\)/);
  assert.match(src, /service\.setSleepHook\(\(\) => sleep\.noteWrite\(\)\)/);
  assert.match(src, /onRun: \(\) => \(dream \? runBackgroundDream\(\)/);
  assert.match(src, /onRun: \(signal\) => \(sleep \? runBackgroundSleep\(signal\)/);
});

test("stale Recent Context and Life intake flags are persisted but never effective", () => {
  const { store, settings } = staleFlagSettings();
  try {
    const flags = settings.getFeatureFlags();
    assert.equal(flags.recentContextEnabled, false);
    assert.equal(flags.trustedIntakeEnabled, false);
    assert.equal(flags.autoDream, true, "unrelated historical flags still round-trip");

    const raw = JSON.parse(
      store.db.prepare("SELECT value FROM user_settings WHERE key = ?").get("feature_flags").value
    );
    assert.equal(raw.recentContextEnabled, true, "the historical kv value is not deleted");
    assert.equal(raw.trustedIntakeEnabled, true, "the historical kv value is not deleted");

    const runtimeCfg = createScopedRuntimeConfig({
      recentContextEnabled: true,
      trustedIntakeEnabled: true,
      recentActivityEnabled: true,
      sceneIsolationEnabled: true,
      sceneStrictQQ: true
    }, {});
    assert.equal(runtimeCfg.recentContextEnabled, false, "runtime config forces the retired key off");
    assert.equal(runtimeCfg.trustedIntakeEnabled, false, "runtime config forces the retired key off");
    assert.equal(runtimeCfg.recentActivityEnabled, true, "the new Workspace-bound module stays independent");
    assert.equal(runtimeCfg.sceneIsolationEnabled, true, "Scene isolation remains the compatibility fallback");
    assert.equal(runtimeCfg.sceneStrictQQ, true, "strict QQ Scene mode is not forced off");
  } finally {
    store.close();
  }
});

test("setFeatureFlags cannot re-enable the retired in-process flags", () => {
  const { store, settings } = staleFlagSettings();
  try {
    const merged = settings.setFeatureFlags({
      recentContextEnabled: true,
      trustedIntakeEnabled: true,
      autoDream: false
    });
    assert.equal(merged.recentContextEnabled, false);
    assert.equal(merged.trustedIntakeEnabled, false);
    assert.equal(merged.autoDream, false);
    assert.deepEqual(settings.getFeatureFlags(), {
      recentContextEnabled: false,
      trustedIntakeEnabled: false,
      autoDream: false
    });
  } finally {
    store.close();
  }
});
