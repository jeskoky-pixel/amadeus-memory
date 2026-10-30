# Mneme-lite Recent Activity Admin API Verification

Task: `9c97a986-19db-4184-a72c-19252165cd63`
Follow-up Session metadata fix: `8c108219-0f50-4959-a331-1520e8c7f035`
Branch: working tree in `private/memory-development/workspace/amadeus-memory`

Scope was limited to the owned paths:

- `dsh-mneme/src/admin-api.js`
- `dsh-mneme/src/settings.js`
- `dsh-mneme/src/index.js`
- `dsh-mneme/src/inject.js`
- synced `dsh-mneme/lib/admin-api.js`
- synced `dsh-mneme/lib/settings.js`
- synced `dsh-mneme/lib/index.js`
- synced `dsh-mneme/lib/inject.js`
- `dsh-mneme/test/admin-recent.test.js`
- `dsh-mneme/test/workspace-hooks.test.js` (one narrow source-wiring assertion
  updated because the `createInjector` signature gate changed)
- `dsh-mneme/docs/verification/MNEME_LITE_RECENT_ADMIN.md`

`npm run sync` also wrote the already-present `src/recent-activity.js`
performance change into `lib/recent-activity.js`; no source edit was made to
that module by this task, but the repository's publish gate requires parity.

No GUI edit, web search, child agent, commit, installed package, live DSH
profile or production data was touched. The legacy root database was not
opened, migrated, restored or deleted.

## API

All routes stay under the existing owner-authenticated, same-origin
`/api/amadeus-memory/admin` prefix. `connection.admit(req)` must resolve to
`peer.principal.kind === "owner"`; POST requests also require
`x-amadeus-memory: 1`.

### `GET /api/amadeus-memory/admin/recent`

Returns only safe status:

```json
{
  "ok": true,
  "data": {
    "active_workspace_id": "stable-workspace-id",
    "selected_workspace_id": "stable-workspace-id",
    "runtime_mode": "selected",
    "enabled": true,
    "configured_enabled": true,
    "pending_restart": false,
    "feature_pending_restart": false,
    "binding_pending_remount": false,
    "config": { "ttl_hours": 24, "auto_inject": true, "max_items": 3, "max_tokens": 300 },
    "stats": {
      "available": true,
      "event_count": 2,
      "source_counts": [{ "source_session_id": "stable-session-id", "count": 2 }],
      "last_updated": 1700000000000,
      "summary_bytes": 240,
      "policy_count": 1,
      "config": { "ttl_hours": 24, "auto_inject": true, "max_items": 3, "max_tokens": 300 }
    },
    "sessions": [
      {
        "id": "stable-session-id",
        "title": "Host session title",
        "last_active_at": 1700000000000,
        "enabled": true,
        "mode": "shared",
        "shared_session_ids": ["another-stable-session-id"]
      }
    ],
    "sessions_available": true,
    "last_activity_available": true
  }
}
```

- Session IDs come only from
  `listWorkspaceSessionIds(ctx, activeWorkspaceId)`. A missing, malformed,
  duplicate-ID or ambiguous-membership Registry returns no session IDs and a
  stable `sessions_error`; it is never presented as a valid empty list.
- Session metadata comes from one awaited `sessionController.list({})` call.
  The official `SessionController.list(_request, signal)` contract is async and
  returns `{ items: [...] }`; the snapshot chain awaits it once and never calls
  a per-Session endpoint.
- Only exact stable-ID matches are enriched: each returned item must have the
  same `sessionId` string as a Session already listed by the trusted Registry.
  Controller-only IDs, other-Workspace IDs and caller data are never listed.
- `updatedAt` is used only when it is a finite, nonnegative number of Host
  milliseconds. Missing, negative, non-finite, string, `null` or otherwise
  malformed timestamps become `last_active_at: null`; they never sort or
  authorize anything.
- `title` is display-only, read from the optional
  `item.projections.values.title` string projection. It is trimmed, C0/C1 and
  bidi/zero-width controls are stripped, whitespace is collapsed and the result
  is bounded to 200 characters. A missing, blank or non-string projection yields
  `title: null`; the stable Session ID remains the fallback identity. Title and
  `updatedAt` are never authorization inputs.
- If the controller is absent, rejects or returns a malformed payload, the
  Registry-listed Sessions remain visible with `last_active_at: null`,
  `title: null` and `last_activity_available: false`. A Host metadata failure
  never removes a Session from the Registry list.
- `shared_session_ids` is filtered against the live selected Workspace list, so
  a stale allowlist entry for a moved Session is not echoed back.
- Stats are Workspace-scoped counts/byte sizes only. They never include summary
  text, raw rows, database paths, or per-source IDs outside the live list.
- `pending_restart` combines the feature restart state and a pending Workspace
  binding remount; the separate `feature_pending_restart` and
  `binding_pending_remount` fields keep the causes distinguishable.
- The previous Recent-card fields (`ttl_ms`, `max_events`, `scenes`,
  `total_events`) and the nested `recent_context` status remain for existing
  clients. `POST /recent/clear` still clears the old trusted-Scene buffer, so
  that pre-existing route is preserved.

### `GET /api/amadeus-memory/admin/recent/preview?target_session_id=<exact ID>&include_self=false`

- Requires an active selected Workspace runtime and a mounted recent-activity
  core; otherwise returns `409` with a stable reason.
- Requires an exact `target_session_id` present in the live strict Workspace
  list. Unknown/moved/ambiguous IDs are rejected before any core read.
- Calls `core.previewRecentActivity({ id: targetId }, { includeSelf })` as the
  target Session, not as an owner override. `include_self` defaults to `false`;
  only the literal `true` enables the explicit owner diagnostic self read.
- Returns a sanitized core DTO (`ok`, `reason`, `items`, `count`,
  `estimatedTokens`, `truncated`) with item fields
  `sourceSessionId/kind/summary/occurredAt/estimatedTokens`. No raw transcript,
  SQL row, database path or caller-supplied identity is returned.
- When the persisted feature flag is explicitly `false`, the response is a safe
  denied DTO (`recent-activity-disabled`) rather than old content, matching the
  model injection denial.

### `POST /api/amadeus-memory/admin/recent/policy`

```json
{
  "source_session_id": "<exact ID>",
  "enabled": true,
  "mode": "self | owner | shared",
  "shared_session_ids": ["<exact ID>"]
}
```

- Requires an active selected Workspace runtime and rejects a pending binding
  switch with `409 binding-pending-remount` before any write.
- Source and every shared target must be in the live strict Workspace list.
  Unknown, ambiguous or moved IDs return `400 unknown-session-id`; the previous
  policy row is untouched.
- Calls `core.setSourcePolicy({ id: sourceId }, ...)`. The returned state
  includes the saved policy plus a refreshed `state` snapshot.
- A dedicated management core, when mounted by `index.js`, lets the owner edit
  policies while the opt-in feature is disabled. It is never subscribed to
  `session/event`; model reads/previews still use the wrapped model core.

### `POST /api/amadeus-memory/admin/recent/config`

```json
{
  "enabled": true,
  "ttl_hours": 24,
  "auto_inject": true,
  "max_items": 3,
  "max_tokens": 300
}
```

- `ttl_hours` accepts only `1 | 6 | 24 | 72` (default `24`).
- `max_items` accepts integers `1..10` (default `3`).
- `max_tokens` accepts integers `100..800` (default `300`).
- `auto_inject` defaults to `true`; `enabled` is optional and uses the existing
  `feature_flags` store under `recentActivityEnabled`.
- Every field is validated before either the config kv entry or the feature flag
  is written. A mixed valid/invalid patch persists nothing.
- The four tunables persist in the selected Workspace's existing settings KV
  (`recent_activity`) through `getRecentActivityConfig` /
  `setRecentActivityConfig`; `enabled` is not duplicated into that entry.
- When a core is mounted, the route calls `core.configure` with the live TTL,
  item and token values. `inject.js` consults the persisted `auto_inject` on the
  next prompt, so disabling it suppresses the next block with no restart.
- Disabling a boot-enabled runtime is immediate: `index.js` wraps the model
  core's `allowSession` callback with a live persisted-flag check, so the next
  event and the next read are denied. Re-enabling in the same mount restores
  the already-mounted core without a restart.
- Enabling a boot-disabled runtime persists the flag but reports
  `enabled: false`, `configured_enabled: true`, `pending_restart: true`; the
  core is not mounted until the plugin restarts. Disabling a boot-enabled
  runtime reports `pending_restart: false`.

## Runtime wiring

- `createRecentActivityRuntime` accepts an optional live `isEnabled` callback.
  The wrapper denies both `onSessionEvent` and `allowSession` (and therefore all
  core reads) when it returns anything other than `true`. A throwing callback
  fails closed.
- `index.js` mounts the model core only under the existing
  `activeWorkspaceId && runtimeCfg.recentActivityEnabled === true` gate, passes
  the persisted TTL/item/token defaults, and supplies
  `isEnabled: () => settings.getFeatureFlags().recentActivityEnabled !== false`.
- A second, unsubscribed management core is created only when the feature was
  enabled at boot. It shares the same isolated store and Workspace guard and is
  used by the owner policy route; it is not a new database and has no event
  listener.
- `createInjector` accepts an optional live persisted-config reader. It checks
  `auto_inject === false` after the authorization gate and before any core read,
  so a failed settings read suppresses the block rather than leaking content.
- Unbound mode still mounts the owner routes for safe status, but config,
  policy and preview mutations return `409 no-active-workspace`. A pending
  binding switch uses only the active boot-time store and rejects mutations
  before data access.

## Tests

Commands run from `dsh-mneme/`:

```text
node test/admin-recent.test.js
node scripts/check-sync.js
npm test
```

`node --test test/admin-recent.test.js` cannot be used in this sandbox: the Node
test runner's per-file child-process spawn fails with `spawn EPERM`, so the file
was run directly. `npm test` uses `scripts/quality.mjs`, which imports all tests
into one process for the same reason.

Results:

```text
node test/admin-recent.test.js   14 tests, 14 pass, 0 fail
check-sync                       ✓ src/ 与 lib/ 一致（91 个文件）
node test/workspace-binding.test.js  14 tests, 13 pass, 1 fail
npm test (quality:amadeus)       708 tests, 707 pass, 1 fail
```

The single full-suite failure reproduces in isolation and is unrelated to recent
activity: `workspace-binding: managed workspaces root cannot be a symlink`
(`test/workspace-binding.test.js:412`). In this Windows environment the test's
junction creation succeeds without an `EPERM`/`EACCES` skip, but the resolver
reports `absent` instead of the expected `unsafe-data-root`. No file changed by
this task participates in that path.

The existing `admin-recent` tests were preserved; the suite grew from 11 to 14
tests. The new regressions cover an async `{ items }` Host list, title
trimming/control stripping/200-character bound, exact Registry filtering,
invalid timestamps, missing projection fallback, and rejecting/missing/malformed
controller fallback.

The suite uses a temporary control root, isolated in-memory SQLite and a fake
Registry/owner connection. It also covers owner auth, strict dynamic Session
listing, no binding, malformed and ambiguous Registry, unknown/moved sources and
targets without DB mutation, policy save/revoke, preview matching the model
core, explicit self preview, per-source disable/re-enable without resurrecting
events, config defaults and bounds, mixed-patch atomicity, persistence, live
`auto_inject`, immediate global disable, boot-disabled enable + pending restart,
pending binding switch, Workspace-scoped stats, legacy route fields, and no raw
transcript/path data.

## Unresolved limitations / honest notes

- No new live DSH Desktop visual acceptance was performed by this follow-up.
  This task verifies the backend routes and tests only; Codex will perform the
  Desktop validation separately.
- The Host title projection is optional display data. When it is absent or not
  a string, `title` is `null`; the stable Session ID remains the fallback
  identity. Title and `updatedAt` are never authorization inputs.
- A host plugin restart (or host-level reload) is still required to enable the
  feature from a boot-disabled runtime, or to adopt a changed Workspace binding.
  `pending_restart`/`binding_pending_remount` report this truthfully.
- TTL changes affect newly recorded events; already-stored events keep the
  expiry calculated when they were written, consistent with the core contract.
- `POST /recent/policy` is unavailable before the feature has ever been mounted
  at boot; enabling first requires the restart above. This is reported as
  `recent-activity-unavailable` rather than silently accepting a policy that
  cannot be enforced.
- `npm run sync` also wrote the already-present `src/recent-activity.js`
  performance change into `lib/recent-activity.js`; this task made no source
  edit to that module, but the sync was required to pass the repository's
  src/lib publish gate.

## Contract check

- [x] GET `/recent` returns active/selected Workspace, runtime and persisted
      enablement, pending restart, persisted config, safe core stats and
      dynamically listed Session DTOs
- [x] Session IDs come only from the strict selected-Workspace list; unavailable
      or ambiguous Registry fails closed
- [x] Last activity awaits the official async controller list once; exact
      Registry IDs are enriched only from returned items, invalid timestamps are
      `null`, and absent/rejecting metadata degrades safely
- [x] Display `title` comes only from the optional Host title projection, is
      trimmed/bounded/control-stripped, falls back to `null`, and is never used
      for authorization
- [x] Preview runs as the exact target, rejects unknown/moved IDs, defaults
      `includeSelf:false`, and returns only the safe core DTO
- [x] Policy saves/reverts immediately and rejects unknown/ambiguous/moved
      source or target IDs without DB changes
- [x] Global config persists per selected Workspace with exact TTL/item/token
      bounds and atomic validation; `enabled` uses the feature-flags store
- [x] Live config calls `core.configure`; `inject.js` consults `auto_inject`
      live; boot-disabled enable is pending restart
- [x] Immediate global disable denies the next event/read through the wrapped
      `allowSession` callback and does not disable original Mneme
- [x] Owner routes exist in unbound mode for safe status; mutations reject until
      a selected Workspace runtime is active; no cross-Workspace data during a
      pending binding switch
- [x] New tests cover auth, list, no binding, strict IDs, async Host title/time
      metadata, invalid timestamps, controller fallbacks, policy save/revoke,
      preview ACL parity, config validation/persistence/restart, immediate
      disable, moved Session, binding pending and no raw transcript
- [x] Targeted `admin-recent` tests pass 14/14; `npm run sync` ran and src/lib
      parity is confirmed; full `npm test` is 707/708 with one unrelated
      environment-dependent symlink test failure documented above
- [x] No web search, external/child agents, commit, GUI edit, installed package
      or production data touched
