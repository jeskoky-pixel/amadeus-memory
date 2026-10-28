# Mneme-lite Recent Runtime Verification

Task: `489413a1-9a61-4deb-8064-dd7333cc23ab`
Branch/worktree: `amadeus-memory` (Codex DSH workspace)

This report covers wiring the reviewed standalone `src/recent-activity.js` core
into the selected Workspace runtime, model injection and one read-only model
tool. It does not claim a complete Memory product or live Desktop acceptance.

## Scope

Owned source paths changed:

- `dsh-mneme/src/index.js`
- `dsh-mneme/src/inject.js`
- `dsh-mneme/src/tools.js`
- `dsh-mneme/src/config.js`
- `dsh-mneme/src/settings.js`
- their synced `dsh-mneme/lib/` copies
- `dsh-mneme/test/recent-runtime.test.js`
- `dsh-mneme/docs/verification/MNEME_LITE_RECENT_RUNTIME.md`

No GUI/admin API, installed package, profile, production database, Dream/Sleep,
Hot Memory, long-term `memories` table or Mneme retrieval algorithm was edited.
No web search, child agent, external agent or commit was used.

Required coupled updates outside the listed owned paths:

- `dsh-mneme/docs/CONFIGURATION.md` — the new schema key must be documented for
  the repository's existing `docs-config-keys.test.js` gate and its light-mode
  list. This is documentation only.
- `dsh-mneme/test/api.test.js` — the existing effective-key count lock moved
  from 115 to 116 because `recentActivityEnabled` is a new feature flag.
- `dsh-mneme/test/workspace-hooks.test.js` — the existing source-wiring needle
  now includes the new seventh `createInjector` argument.

## Runtime wiring

`src/index.js` now exposes:

- `createRecentActivityOwnerCheck(ctx)` — Host-only owner predicate.
- `createRecentActivityRuntime({ ctx, db, workspaceId, authorizeModelWork,
  isTrustedOwner, config, logger, now })` — mounts the core and the trusted
  `session/event` bridge.

Mount conditions:

1. A selected Workspace exists (`activeWorkspaceId` is set).
2. `runtimeCfg.recentActivityEnabled === true` (new opt-in, default false).

The core is created over the already-open `store.db` of the selected isolated
Workspace. No second database, legacy root DB or unbound DB is opened. The
runtime access guard's existing `authorizeModelWork(actualHostSession)` closure
is the only allow callback.

The `session/event` wrapper:

- forwards only `event.type === "turn/end"`;
- re-checks `authorizeModelWork(session)` before calling the core, so a moved
  Session, an unbound runtime and a binding switch deny immediately (the guard
  also latches a binding change as `binding-changed-pending-remount`);
- swallows every callback/storage error; a recent-activity failure never
  escapes into Mneme's event chain;
- returns a disposer that is pushed into the runtime's `disposers` list and
  removes the listener on plugin unload.

The `session/event` callback receives the host's actual Session object and the
actual event object. The core uses the Session's `snapshotEvents()` when
available (falling back to `.events`), so the turn window is rebuilt from the
same public event log the other reviewed code uses.

## Owner mode

`owner` sharing mode consults only the optional Amadeus QQ Host service through
`safe optional service access` (`ctx.reflect.get("qq")`, with a guarded plain
property fallback for mock/older hosts).

A target is owner only when `resolveTrustedSessionScene(actualSession.id)`
returns exactly:

```js
{ platform: "qq", kind: "private", admin: true }
```

Missing QQ, a missing method, a throw, a non-QQ platform, a non-private kind or
`admin !== true` all return false. Session titles, names, agent presets, model
arguments and HTTP fields are never consulted. QQ is not imported, required or
made a startup dependency.

## Prompt injection

When the core exists and `recentActivityEnabled` is on, `src/inject.js`
registers a separate context block:

- name: `recent-activity`
- order: `87` (distinct from `memory` at 90 and `user-settings` at 85)
- text: generated per assembly by `renderAuthorized` and then
  `renderRecentActivityContext`

Rendering rules:

- `readRecentActivity(actualHostSession, { includeSelf: false, maxItems, maxTokens })`
  omits the current Session so original Hot Memory is not duplicated.
- `maxItems`/`maxTokens` come from the core's `getConfig()` and therefore obey
  the module's hard `1..10` items and `100..800` token limits.
- The Workspace gate is checked before the read and again immediately before
  the text is returned; denied, unbound, moved, empty or disabled states emit
  an empty string.
- Summaries are labelled as past, untrusted observations from other Sessions
  and explicitly not instructions.
- Prompt variables in IDs/summaries are escaped with the injector's existing
  `escapePromptVars`.
- The block is registered only when the opt-in core exists. A disabled flag
  creates no core, no listener, no block and no tool.

The original `memory` block (including Hot Memory and long-term memory) is not
merged or changed; a regression test asserts the block is byte-identical with
and without the recent core.

## Model tool

`src/tools.js` adds one read-only tool only when the core exists:

`memory_recent_activity`

Parameters are only narrowing filters:

- `query` (substring, bounded by the core to 200 chars)
- `sources` (exact source Session IDs, max 32, only narrows eligible sources)
- `since` / `until` (epoch-ms bounds on turn completion time)
- `limit` (core clamps to 1..10)

The target identity always comes from the invocation's trusted
`exec.agent.session` (`sessionOf(exec)`). Model arguments cannot supply the
target Session, owner status, Workspace ID, clock or policy. In particular
`now`, `owner`, `workspaceId`, `mode` and `policy` are not read or forwarded
even if a caller passes them.

The tool returns only a normalized safe DTO:

```js
{
  ok, reason,
  items: [{ sourceSessionId, kind, summary, occurredAt, estimatedTokens }],
  count, estimatedTokens, truncated
}
```

It never returns SQL rows, idempotency keys, expiry columns, policy rows or raw
chat logs. The existing `withModelAccess` wrapper still runs first for every
registered tool, so the tool refuses with `WORKSPACE_ACCESS_DENIED` outside the
selected Workspace; the core re-checks policy and Workspace membership as well.

## Tests

`test/recent-runtime.test.js` (11 tests) covers:

- selected A1 records a trusted `turn/end`; other event types do not;
- a throwing authorization callback never escapes and disposal removes the
  listener;
- A2 sees A1 only after an explicit `shared` policy (both prompt block and
  tool); B1 gets no injection and a denied tool;
- moved Session and binding switch deny recording, injection and tool data
  immediately;
- owner predicate accepts only the exact optional QQ Host scene; forged
  name/title/preset and wrong kind/platform/admin shapes are denied; missing or
  throwing QQ defaults false;
- owner policy reads only Host-confirmed owner targets;
- disabled flag adds no hook, injection block or tool;
- module item/token limits are respected and `includeSelf: false` avoids
  duplication;
- Hot Memory block is byte-identical with/without the core;
- `src/recent-activity.js` has no QQ dependency;
- full plugin boot with the flag off registers no tool/block, and with the flag
  on records a real `session/event` and serves the tool.

Commands run directly (the repository's `node --test` runner spawns child
processes, which this Windows DSH sandbox blocks with `spawn EPERM`):

```text
node test/recent-runtime.test.js             11/11 pass
node test/recent-activity.test.js            12/12 pass
node test/workspace-runtime.test.js          13/13 pass
node test/workspace-hooks.test.js            17/17 pass
node test/tools.test.js                      32/32 pass
node test/inject.test.js                     30/30 pass
node test/config.test.js                      4/4  pass
node test/settings.test.js                   21/21 pass
node test/docs-config-keys.test.js            2/2  pass
node test/api.test.js                        76/76 pass
node test/memory-management-api.test.js      17/17 pass
node test/admin-workspace.test.js             9/9  pass
node test/api-hardening.test.js               7/7  pass
node test/workspace-gate.test.js             16/16 pass
node test/qq-host-inject.test.js              3/3  pass
node test/scene-recent-core.test.js           9/9  pass
node test/lib-smoke.test.js                   6/6  pass
node test/tools-dto-schema-matrix.test.js     7/7  pass
node test/tools-memory-get-schema.test.js     2/2  pass
node test/scope-strict.test.js               16/16 pass
node test/inject-parent-gate.test.js          5/5  pass
node test/memory-enhancer-tools.test.js       8/8  pass
node test/scope-state.test.js                25/25 pass
```

`node scripts/check-sync.js` reports `✓ src/ 与 lib/ 一致（90 个文件）` after
`npm run sync`.

Known environment-only failure: `node test/workspace-binding.test.js` passes
12/13; the Windows junction/symlink test
(`managed workspaces root cannot be a symlink`) sees the junction as absent in
this sandbox. That module and its test were not edited by this task; the
failure is unrelated to recent activity.

## Event shape assumptions

Assumed live host contract (same shapes the reviewed core and existing
`summarize.js`/`hot-memory.js` consumers already use):

- `ctx.on("session/event", (session, event) => ...)` receives the actual
  Host Session and event.
- `turn/end` carries a non-negative safe-integer `event.seq`.
- The Session exposes a full public event array via `snapshotEvents()` or
  `.events`, containing `user/message` with `data.source.kind === "user"` and
  text content blocks, and `assistant/message` with
  `data.message.content`.
- Event order and `seq` are stable and monotonic enough for the previous
  `turn/end` window calculation used by the core.

## Unresolved live-Host validation

No live DSH Desktop, QQ Bridge or production Workspace was available in this
task. The tests use temporary SQLite stores and synthetic Host sessions/events,
so the following remain unverified against a live Host:

- the exact production `turn/end` payload and whether every Host version
  exposes `seq` in the same place;
- the real QQ `resolveTrustedSessionScene` result shape in a deployed Host;
- Desktop panel/reload behavior while the flag is toggled (the flag is read at
  mount time; a running instance needs a remount after changing it);
- whether a future GUI chooses to expose the opt-in and policy editing. No GUI
  or admin API was edited here.

These are integration assumptions, not claimed acceptance. The module remains
default-off and fail-closed.
