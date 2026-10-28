# Mneme-lite runtime convergence

Task: `246a948e-61ad-4776-ac19-efaedee3da74` (narrow runtime convergence).
Scope kept to `src/index.js`, `src/config.js`, `src/settings.js`, their synced
`lib/` copies, focused tests, and this verification note.

## What changed

### 1. Common lite path uses original Mneme Dream/Sleep

`index.js` now decides per background run whether persisted Scene buckets must be
enumerated:

```js
export function needsSceneScopedBackgroundJobs({ sceneIsolationEnabled, hasSceneScopedRows }) {
  return sceneIsolationEnabled === true || hasSceneScopedRows === true;
}
```

- **Lite path** — selected Workspace, `sceneIsolationEnabled !== true`, and
  `store.hasSceneScopedRows() === false`: `runBackgroundDream()` calls
  `dream.runDream(ctx, service, runtimeCfg)` directly and
  `runBackgroundSleep(signal)` calls the imported original
  `runSleep(ctx, service, runtimeCfg, ctx.logger, { embedder, vectorIndex }, signal)`
  directly. No `listSceneScopes` call, no bucket loop, no `runWithSceneJob`.
- **Compatibility path** — any tagged memory row or explicit Scene isolation:
  the existing `runScopedDreams()` / `runScopedSleep()` loop is used unchanged,
  including Scene-job scoping, per-Scene audit rows, the aggregate Dream baseline
  and the Sleep abort/processed/total outcome.
- The decision is re-evaluated on every scheduled run, not only at boot, so a
  database that later contains a tagged row switches to the safe per-Scene path.
- Dream/Sleep scheduler constructors, thresholds, peak-hour options, failure
  backoff, baselines, `service.enqueue` ordering and the `setDreamHook` /
  `setSleepHook` wiring are untouched.

No tagged row can be processed by the unscoped path: the direct path requires
`hasSceneScopedRows() === false`. While Scene isolation is off, this runtime
cannot mint a tagged row; a concurrent external writer mutating the same SQLite
file is outside the runtime's supported single-owner contract.

### 2. Recent Context and Life trusted intake are retired

Both historical opt-ins remain in the config schema, feature-flag whitelist,
settings KV, tables and API modules, but they are never effective in the
Workspace-bound runtime:

- `settings.js` exports `RETIRED_FEATURE_FLAGS = ["recentContextEnabled",
  "trustedIntakeEnabled"]`. `getFeatureFlags()` reads a stale persisted `true` as
  `false`; `setFeatureFlags()` also stores `false` for an attempt to re-enable
  them. The underlying KV value is not deleted by a read.
- `createScopedRuntimeConfig()` (used for every plugin runtime) overlays both keys
  with `false`, so a stale feature flag or legacy bundle config cannot make
  `runtimeCfg.recentContextEnabled` or `runtimeCfg.trustedIntakeEnabled` true.
  `configureRecentContext({ enabled: false })` and the `/intake` route gate
  therefore stay closed.
- Feature/effective snapshots in both API surfaces read the same runtime config
  and the normalized settings read, so the panel cannot report these retired
  surfaces as enabled.
- `recentActivityEnabled` is deliberately unaffected and still mounts the
  Workspace-bound recent-activity core when explicitly enabled.
- No table, column, historical module or data was removed. `sceneIsolationEnabled`
  and `sceneStrictQQ` were not forced off; they remain the compatibility fallback
  for existing tagged data.

## Tests added/updated

- `test/lite-runtime-convergence.test.js` (new): direct-vs-scoped decision,
  source wiring for both Dream and Sleep, persisted stale flags are read false
  without deleting the raw KV value, runtime config forces retired keys false,
  `recentActivityEnabled` remains independent, and re-enabling a retired key
  through `setFeatureFlags` still stores false.
- `test/summarize-scene-contract.test.js`: the old assertion that all
  Dream/Sleep runs must go through `runWithSceneJob` is intentionally superseded;
  it now asserts both the direct lite calls and the retained per-Scene wrappers.
- `test/memory-management-api.test.js`: the owner feature API now expects Scene /
  strict-QQ / Core to round-trip while retired Recent Context and Life intake
  stay false in `effective`.

The focused test file is not in `scripts/quality.mjs` because that file is outside
this task's owned scope. It was run directly instead.

## Validation

Executed in `dsh-mneme/` on Windows:

| Command | Result |
| --- | --- |
| `node test/lite-runtime-convergence.test.js` | 5 pass, 0 fail |
| `node test/settings.test.js` | 21 pass, 0 fail |
| `node test/summarize-scene-contract.test.js` | 10 pass, 0 fail |
| `node test/memory-management-api.test.js` | 17 pass, 0 fail |
| `node test/workspace-runtime.test.js` | 13 pass, 0 fail |
| `node test/workspace-hooks.test.js` | 17 pass, 0 fail |
| `node test/scene-background.test.js` | 14 pass, 0 fail |
| `node test/trusted-intake.test.js` | 7 pass, 0 fail |
| `node test/api.test.js` | 76 pass, 0 fail |
| `node test/memory-admin-api.test.js` | 6 pass, 0 fail |
| `node test/recent-runtime.test.js` | 11 pass, 0 fail |
| `node test/lib-smoke.test.js` | 6 pass, 0 fail |
| `node scripts/check-sync.js` | `✓ src/ 与 lib/ 一致（90 个文件）` |
| `node scripts/quality.mjs` | 540 pass, 0 fail |

Environment limitations, reported rather than hidden:

- `node --test ...` fails under this Windows sandbox with `spawn EPERM` because
  the runner spawns child processes with piped stdio. Test files were executed
  directly, which runs the same `node:test` assertions in one process.
- `npm test` stops at its privacy step before the test runner because a
  pre-existing untracked `dsh-mneme/mneme-lite-test.log` is flagged as a
  forbidden artifact. That file predates this task and was left untouched. The
  quality test runner behind that step was run directly (`540 pass, 0 fail`).
- A direct run of `test/workspace-binding.test.js` has one Windows-specific
  symlink/junction case failing (`13/14`); it is unrelated to the files changed
  here and is not part of the quality runner list.
- No real DSH Desktop UI, installed profile or production database was exercised;
  this is a source/lib test verification only.

## Performance / compatibility implications

- Common path: one indexed `hasSceneScopedRows()` probe per background run, then
  the original Dream/Sleep implementation. This removes a `GROUP BY` Scene
  enumeration and per-Scene AsyncLocalStorage scopes for new Workspaces.
- A fresh Workspace now runs Dream/Sleep through the original functions instead
  of returning the old `"no-scenes"` skip. That is the intended original-Mneme
  behavior; the functions still apply their own candidate/threshold guards.
- Legacy databases keep the exact per-Scene behavior, including isolation and
  aggregation. No migration, schema change, data deletion or scope-semantic
  change was made.
- Retired flag normalization is read-time and additive; raw historical KV values
  are preserved until a later write. The panel/API reports effective status from
  the current runtime, not from stale persistence.
