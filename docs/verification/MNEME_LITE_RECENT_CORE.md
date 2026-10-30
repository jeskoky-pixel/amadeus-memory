# Mneme-lite Recent Activity Core Verification

Task: `8dd9d086-0907-47a1-8df6-fe9db3fc3bb5` (initial core)
Review-fix task: `0fcabb8e-f13d-48da-aee1-473f3bd8b722`
Session-settings policy task: `5bb9fa14-27bc-469c-9781-18dc6505f53e`
Bounded recent-activity collection task: `a5367f66-9415-4b2a-aae9-7df2f7a5408d`
Branch: `codex/memory-mneme-lite`

Scope was limited to the four owned paths:

- `dsh-mneme/src/recent-activity.js`
- `dsh-mneme/lib/recent-activity.js`
- `dsh-mneme/test/recent-activity.test.js`
- `dsh-mneme/docs/verification/MNEME_LITE_RECENT_CORE.md`

No long-term Mneme tables, Dream/Sleep, Hot Memory, retrieval, GUI, API routes,
settings, package metadata, installed package, profile or production database were
edited. No web search, child agent, commit or scope expansion was used. Only this
module's `lib/recent-activity.js` copy was synchronized; the broader `npm run sync`
was not run because it would rewrite unrelated module copies.

## Exported API

### `createRecentActivityCore({ db, workspaceId, allowSession, isTrustedOwner, config, now, logger })`

Creates a core over the caller's already-open `DatabaseSync` from the selected
Workspace's isolated Mneme store. Construction never throws. A missing/invalid
database or Workspace ID yields `status().ok === false` and every method fails closed.
No database is created, opened or closed by the module.

Returned methods:

```js
status()                                  // { ok, reason, workspaceId }
configure({ ttlHours, maxItems, maxTokens }) // returns effective config
getConfig()
stats()                                   // bounded owner-GUI aggregates
onSessionEvent(session, turnEndEvent, { now })
recordTurnEnd(session, turnEndEvent, { now }) // same function
setSourcePolicy(sourceSession, policy, { now })
getSourcePolicy(sourceSession)
readRecentActivity(targetSession, options)
previewRecentActivity(targetSession, options) // same function
```

Also exported:

- `RECENT_ACTIVITY_LIMITS` — immutable hard limits/defaults.
- `estimateRecentActivityTokens(text)` — local CJK/ASCII heuristic, no LLM.

### Policy shape

`getSourcePolicy` and a successful `setSourcePolicy` return:

```js
{
  ok: true,
  mode: "self" | "owner" | "shared",
  sharedSessionIds: [],   // exact IDs; empty unless mode is "shared"
  enabled: true           // independent per-source switch
}
```

The default policy is `self` with `enabled: true`. `enabled` is independent of the
three sharing modes. A supplied `enabled` must be a real boolean; omitting it
preserves the stored switch (a new Session defaults to true). Changing mode or the
allowlist therefore never silently re-enables a disabled Session. Rejected writes
leave the previous policy unchanged.

### `readRecentActivity(targetSession, options)`

Options:

```js
{
  sources,          // optional exact source Session ID allowlist (max 32)
  includeSelf,      // default true; false omits the target's own events
  since, until,     // optional epoch-ms range on recorded turn/end time
  query,            // optional case-insensitive substring over summaries (max 200 chars)
  maxItems,         // default 3, hard clamp 1..10
  maxTokens,        // default 300, hard clamp 100..800
  now               // optional test/diagnostic clock override
}
```

Returns a safe DTO only:

```js
{
  ok, reason,
  items: [{
    sourceSessionId, kind, summary, occurredAt, estimatedTokens
  }],
  count, estimatedTokens, truncated
}
```

It never returns SQL rows, idempotency keys, turn sequence numbers, expiry columns,
policy rows or arbitrary event metadata. Items are ranked newest first; query filtering
and the token budget are applied before return. `estimatedTokens` is the sum of the
returned item costs (each includes an 8-token item overhead).

Read options are not a policy channel: unknown fields such as `mode`, `owner` or
`enabled` are ignored. Only the owner API, not a model tool or read caller, invokes
`setSourcePolicy`.

### `stats()`

Bounded, read-only aggregates for the owner GUI:

```js
{
  ok, reason,
  eventCount,       // retained event rows for this Workspace
  sourceCounts: [{ sourceSessionId, count }], // bounded per-source counts
  lastUpdatedAt,    // max(event occurred_at, policy updated_at), or null
  summaryBytes,     // rough UTF-8 byte length of stored summary text
  policyCount,      // policy rows for this Workspace
  config: { ttlHours, maxItems, maxTokens }
}
```

Every query is filtered by this core's `workspace_id`. The result contains no
summary text, allowlists, SQL rows or other Workspace IDs. `sourceCounts` is ordered
by count descending then source ID ascending and is naturally bounded by
`MAX_EVENTS_TOTAL`. Expired-but-unpruned rows are retained storage and remain counted
until normal read/write maintenance removes them. `stats()` mutates nothing, performs
only aggregate SQL, and is not called from the model read/injection path. If storage is
unavailable at construction it returns `ok: false` with zeroed fields; a failing query
returns `ok: false, reason: "stats-failed"` rather than throwing.

## Storage

The module runs these additive, idempotent statements on every core creation:

```text
recent_activity_events
  idempotency_key TEXT PRIMARY KEY
  workspace_id, source_session_id, turn_seq, kind, summary,
  occurred_at, expires_at, created_at
  unique(workspace_id, source_session_id, turn_seq)
  index(workspace_id, source_session_id, occurred_at DESC)
  index(workspace_id, expires_at)

recent_activity_source_policy
  workspace_id, source_session_id, mode, allowlist,
  enabled INTEGER NOT NULL DEFAULT 1, updated_at
  PRIMARY KEY(workspace_id, source_session_id)
  index(workspace_id, updated_at)
```

- Only `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` plus the one
  additive policy-column upgrade below. No `memories` read or write, no Dream/Sleep
  feed, no long-term retrieval.
- Upgrade path: after the schema statements, `PRAGMA table_info` checks the live
  policy table. If `enabled` is missing, the core runs
  `ALTER TABLE recent_activity_source_policy ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1`.
  Existing modes, allowlists, timestamps and rows are preserved, all old policies
  default to enabled, and repeated core creation finds the column and performs no
  second alteration.
- `workspace_id` is a defence-in-depth namespace in addition to the caller's isolated
  database, so one physical DB cannot mix two Workspace scopes.
- Hard caps: summary 800 chars, topic snippet 80, outcome snippet 120, source query
  200, exact IDs 256, shared allowlist 32, source filter 32, 50 events/source Session,
  500 events/Workspace, 200 policy rows/Workspace, and 256 Host event positions per
  completed-turn snapshot (`MAX_TURN_EVENT_WINDOW`).
- TTL is recorded per event (`expires_at`) from the configured 1/6/24/72 hours;
  default 24h. Expired rows are deleted on authorized reads and on writes.
- Event retention keeps the newest rows; global and per-Session caps bound DB growth.

### Policy row cap

The old 200-row behavior deleted the oldest policy rows, which could silently
return a disabled or shared Session to the permissive default. That deletion is
removed. The bounded-write rule is now:

- an existing `(workspace_id, source_session_id)` row may always be updated, even at
  the cap;
- if a brand-new row would exceed `MAX_POLICY_ROWS`, the write fails explicitly with
  `reason: "policy-cap-reached"`, inside a rolled-back savepoint, and no old policy is
  changed.

There is no eviction path for policy rows.

## Trust and policy

Every write/read begins with `allowSession(actualHostSession)` and fails closed on
missing callbacks, throws, or a non-true decision. Record and policy writes recheck
the actual Host Session immediately before the savepoint is released, so a
revocation during summary collection cannot commit.

Read path:

1. Gate the actual target Session.
2. Read the target's policy. If its `enabled` switch is false, deny immediately with
   `reason: "source-disabled"` and an empty safe DTO; auto-injection already treats
   any non-`ok` result as no content.
3. Enumerate stored source Session IDs and re-authorize each stored source by its exact
   stable ID through `allowSession({ id })`. The core deliberately does not retain Host
   Session objects or raw transcripts.
4. Skip a source immediately when its current policy `enabled` is false. Then apply the
   sharing mode:
   - `self` (default when no row exists): only the same Session.
   - `shared`: only exact target Session IDs in the bounded allowlist.
   - `owner`: only a target for which the caller-provided
     `isTrustedOwner(actualTargetSession)` returns exactly `true`; default false.
5. Apply TTL, time range, query and limits, then recheck the target's Workspace access
   and `enabled` switch before returning.

Disabling a Session therefore affects the very next read: its stored events disappear
from every other target preview, and its own explicit read is denied. Re-enabling
restores normal mode/allowlist behavior for events that are still unexpired; events
that expired while disabled stay gone. A moved target is denied by the Workspace gate.
A moved source is omitted because its stable-ID membership check fails. Session titles,
names, presets, models, paths and caller arguments are never read as authority.

`setSourcePolicy` accepts only `mode`, exact stable `sharedSessionIds` and an optional
boolean `enabled`; invalid modes/lists/switches fail closed. In `shared` mode every
exact target Session ID is independently checked through `allowSession({ id })` before
persistence and again immediately before the commit. A target from another Workspace,
an unknown target, a missing callback or a throwing callback rejects the whole write
and leaves the previous policy unchanged, so the GUI cannot pre-authorize an unrelated
Session. Read-time target/source checks remain authoritative. Only the owner API is
expected to call this setter; it is not part of the model tool parameter surface.

## Collection and summary

`recordTurnEnd` accepts only `event.type === "turn/end"` and requires a non-negative
safe integer `event.seq`. Missing sequence and non-turn/end events are rejected. After
the access gate it reads the source policy and returns `source-disabled` before
calling `snapshotEvents()` or touching `.events`, so a disabled Session performs no
transcript/summary work and writes no event. The enabled switch is checked again
immediately before the commit, so a disable during summary collection rolls the write
back. The idempotency key is a SHA-256 over stable Session ID + event sequence
(Workspace ID is included only as a namespace to keep shared-physical-DB scopes
collision-free).

Only a bounded suffix of the completed turn is read. With
`MAX_TURN_EVENT_WINDOW = 256`, `recordTurnEnd` computes
`startSeq = max(0, turnSeq - 256)` and calls
`session.snapshotEvents(startSeq, turnSeq)`. The installed Host defines this as the
half-open log slice `[startSeq, turnSeq)`, so the trusted `turn/end` at `turnSeq` is
excluded and no older history is requested. If an older Host ignores the arguments or
the Session only exposes `.events`, every candidate is re-filtered by
`startSeq <= seq < turnSeq` and at most the newest 256 positions are kept. The logical
window is therefore the same on all paths, although an older Host or `.events` fallback
still has to materialize its full array.

Within the bounded window, the latest `turn/end` is the current-turn boundary. Events at
or before that known boundary are dropped, so a summary never merges content across a
previous turn. If the window is truncated (`startSeq > 0`) and contains no known previous
`turn/end`, the turn may be longer than the cap: only the visible suffix is summarized,
the summary includes `Scope: partial turn window`, no tool results are counted, and
`kind` is forced to `conversation`. A partial view can therefore never claim unverified
`agent_action` success; if it has no public topic/outcome text, no row is written.
Synchronous `snapshotEvents` access is deprecated by the Host. This integration keeps the
callback bounded but does not redesign it; a future async event stream would be
preferable.

From those events, only public user/assistant text is used:

- public user messages: `source` must be absent/null (legacy) or a non-array object
  with `kind === "user"` and no plugin marker. Strings, arrays, numbers, objects without
  `kind`, unknown kinds and plugin injections fail closed;
- public assistant text blocks only; reasoning/private blocks are ignored;
- `plan/*` events and pending/streaming/incomplete assistant messages are ignored;
- tool call/result text is never copied into the summary.

The deterministic no-LLM summary is:

```text
Topic: "<first-sentence user snippet, max 80 chars>";
Outcome: assistant reply began "<first-sentence assistant snippet, max 120 chars>";
Tool evidence: N non-error tool result(s)[, M error tool result(s)];
Scope: partial turn window        (only when the turn exceeds the bounded window)
```

Long inputs are clipped with `…`; full long user/assistant messages are never stored or
returned. The stored text is an extractive activity description, not a semantic summary:
a short message can fit entirely inside the snippet cap, and the text cannot infer intent
or real-world outcomes beyond the bounded excerpt. No per-message or per-summary LLM call
exists.

`kind` is `agent_action` only when the completed turn has at least one structurally
verified tool result with an explicit `isError === false` (new `role: "tool"` message or
legacy `tool-result` block) or a `tool/code-dispatch` with an explicit
`isError === false`, and no error result. A `tool/call` alone, a pending tool message, or
a result whose success/error status is missing or unknown yields `conversation`. This is
evidence of a non-error tool result, not a guarantee that every subtask or plan succeeded.

Repeated turn/end events are deduplicated by key and by the unique turn index.

## Bounded window performance notes

Synthetic in-process measurement: 10,000 contiguous events, 200
`recordTurnEnd` calls after 10 warm-ups, Node's in-memory SQLite. The numbers include
the fixed database work but not the Host's own event-materialization cost; they are
not a real Host latency measurement.

| Collection path | Positions requested / kept | Median | p95 |
| --- | --- | --- | --- |
| Bounded `snapshotEvents(startSeq, turnSeq)` | 256 / 256 | 0.097 ms | 0.161 ms |
| Older Host ignores arguments | 256 requested; 10,000 returned; 256 kept | 0.103 ms | 0.142 ms |
| `.events` fallback | 10,000 scanned; 256 kept | 0.133 ms | 0.181 ms |

The timing difference in this synthetic is within noise because the SQLite write
dominates; it does not prove a real Host latency gain. The structural guarantee is the
bounded request: a conforming Host materializes at most 256 event positions per
completed turn instead of the entire Session log, so this collector's per-turn work no
longer grows with total Session history. The fallback paths still pay for the Host's
full array, which is why an async event stream is the preferable future integration.

## Tests

Command (from `dsh-mneme/`):

```text
node test/recent-activity.test.js
```

Direct in-process execution was used because this sandbox rejects the
`node --test` runner's child-process spawn with `EPERM`; the file contains the same
`node:test` cases either way.

Actual result:

```text
1..20
# tests 20
# pass 20
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

Compatibility spot-check of the already-integrated runtime (no runtime files were
edited by this task):

```text
node test/recent-runtime.test.js
1..11
# tests 11
# pass 11
# fail 0
```

Coverage in `test/recent-activity.test.js`:

1. Default self-only cross-Session deny, explicit self query, safe DTO keys, and no
   `memories` writes (also verifies no `memories` table is created on a clean DB).
2. Explicit shared allow, duplicate allowlist normalization, immediate revoke, moved
   target denial, moved source omission, and self-query behavior.
3. Owner impersonation via name/title/preset/model denied; Host callback success;
   default-false and throwing callbacks denied; moved owner denied.
4. Repeated turn/end dedupe, event and policy persistence across close/reopen restart.
5. TTL selection 1/6/24/72 and expired row deletion.
6. Plugin/subagent injection, reasoning, plan, tool-call-only, failed action and pending
   assistant exclusion; legacy user events; missing sequence and no-public-text rejection.
7. Malformed user `source` (string, kind-less object, array) exclusion; tool results with
   no explicit `isError` stay `conversation` while explicit non-error results remain
   `agent_action`.
8. Long user/assistant text is stored/returned only as bounded topic/outcome snippets;
   text caps, default 3 items, token budget, 50-row per-Session cap, and 500-row global
   cap across many Sessions.
9. Gate-before-read, recheck-before-commit rollback, denied-read no-prune, absent
   callback, invalid database and throwing callback fail-closed behavior.
10. Bounded policy validation, unauthorized source denial, allowlist dedupe, rejection of
    an out-of-Workspace/unknown shared target with unchanged policy, and self-policy reset.
11. Time range, case-insensitive query, empty/invalid source filters, invalid options
    and inverted range behavior.
12. Workspace namespacing on one shared physical database.
13. Enabled defaults true, non-boolean switches rejected, omitted switch preserves the
    previous value across mode changes, and the switch survives close/reopen restart.
14. Disabled Session skips transcript collection (no `snapshotEvents` call), denies its
    own explicit read (model-supplied policy fields cannot override it), is omitted from
    a shared target preview immediately, re-enables to show unexpired events, and does
    not resurrect expired events.
15. Old policy table without `enabled` upgrades additively with one default column,
    keeps old `shared`/`owner` rows and allowlists, leaves `memories` untouched, and a
    second core creation is harmless.
16. Policy cap rejects a new row with `policy-cap-reached` without evicting the oldest
    disabled/shared rows, while existing rows can still be updated at the cap.
17. `stats()` is Workspace-scoped, reports event/per-source/last-update/byte/policy/config
    aggregates, contains no summary text or unrelated Workspace IDs, mutates nothing,
    and fails safely for an unavailable or closed database.
18. A 10,000-event synthetic Session records the exact requested range: the collector
    asks for 256 positions ending at the trusted `turn/end`, and the summary contains
    only the latest completed turn, not the previous or ancient turn.
19. Older Hosts that ignore snapshot bounds, Sessions with only `.events`, and a throwing
    `snapshotEvents` all keep the same seq filtering/window cap and the correct latest
    turn without merging earlier content.
20. A current turn longer than the 256-position cap degrades to a partial summary with a
    `Scope: partial turn window` marker, no tool evidence, and `conversation` even when a
    non-error tool result is visible; it never asserts unverified success.

All databases are temporary files under the OS temp directory and are closed/removed
after the tests.

## Limitations and integration notes

1. This is a standalone core. An owner GUI/API must authenticate its caller and then
   call `stats()`/the policy methods; the core's `stats()` itself performs no session
   authentication because it takes no Session and returns no raw data.
2. No live DSH Host Session/event trace was exercised. Event shapes follow the existing
   `snapshotEvents()`/`.events` consumers in this repository: `user/message`,
   `assistant/message`, `tool/call`, `tool/result`, and `turn/end` with numeric `seq`.
3. Stored sources can only be re-checked by stable ID (`allowSession({ id })`); holding
   actual Host Session objects would retain live chat logs. A gate implementation that
   depends on more than the stable ID will fail closed for stored sources.
4. `isTrustedOwner` and `allowSession` are expected to be synchronous. A Promise or a
   non-true value denies.
5. TTL is fixed on each recorded row. Changing `ttlHours` later affects new rows, not
   already-recorded rows.
6. `occurredAt` is the turn/end processing time supplied by the clock, not a parsed
   event timestamp.
7. Auto-injection is not implemented here. A later runtime should call
   `readRecentActivity` with `includeSelf: false`, its configured item/token budget,
   and only after the same Workspace gate has allowed the Session. A `source-disabled`
   denial is intentionally safe to treat as empty content.
8. `kind === "agent_action"` means the turn had an explicit non-error tool-result
   evidence; it is not a claim that every tool, subtask or plan fully succeeded.
9. The no-LLM summary is extractive and deterministic, not semantic. It preserves only a
   bounded first-sentence topic (80 chars) and assistant outcome (120 chars), so a short
   message can still appear nearly verbatim, and the summary cannot reliably infer the
   user's intent, the real-world result, or whether a plan was completed. Long messages
   are clipped and never stored in full. There is no raw transcript in the table.
10. `stats()` is an aggregate storage view, not an event browser: it returns no summary
    text and no Workspace IDs, and expired-but-unpruned rows count as retained storage
    until maintenance removes them. It is not invoked by model reads, injection or the
    recent-activity tool, so it adds no hot-path transcript scan.
11. `lib/recent-activity.js` was synchronized by copying only this module's source file;
    parity was verified by SHA-256. The broader `npm run sync` was not used because it
    would rewrite unrelated module copies in this shared workspace.
12. No GUI, live Desktop, production database or installed package acceptance is claimed.
13. The 256-position cap is a hard limit. On a conforming Host the bounded range keeps
    snapshot materialization and collection at a fixed ceiling per completed turn. On an
    older Host that ignores the range arguments, or when only `.events` exists, the Host
    still materializes the full array; this module filters it once and retains at most
    256 positions, but cannot remove the Host-side cost.
14. Synchronous `snapshotEvents` reads are deprecated by the installed Host. The callback
    is kept bounded here and host integration is not redesigned; a future async event
    stream would be preferable. The synthetic timing table is not a real Host latency
    measurement and no production or live-Session improvement is claimed.

## Contract check

- [x] Only the four owned paths were edited; no other source, config, GUI or installed files.
- [x] Independent `enabled` switch persisted with default true; setter requires an explicit
      boolean when supplied and preserves it when omitted.
- [x] Collection checks `enabled` before any transcript snapshot and rechecks before commit.
- [x] Disabled source events are omitted from other previews; the disabled Session's own
      explicit read is denied; re-enable does not resurrect expired events.
- [x] Additive, idempotent `enabled` migration; old modes/allowlists preserved; repeated
      creation harmless; long-term tables untouched.
- [x] Policy eviction removed. New rows fail explicitly at the cap; existing rows still
      update; old disabled/shared policies are never silently relaxed.
- [x] Bounded `stats()` is Workspace-scoped, returns no raw text or unrelated Workspace IDs,
      is read-only, and fails safely when storage is unavailable.
- [x] Additive idempotent recent-event and per-source policy tables/indexes only.
- [x] No `memories` write, no Dream/Sleep feed, no long-term retrieval/GUI/tool change.
- [x] Trusted Host Session gate before reads/writes and recheck before write commit.
- [x] Missing event sequence rejected; idempotency from stable Session ID + sequence.
- [x] Completed-turn snapshot reads request at most 256 event positions ending immediately
      before the trusted `turn/end`; older-Host and `.events` fallbacks are seq-filtered and
      locally capped; public user/assistant text only.
- [x] Latest previous `turn/end` inside the bounded window bounds the summary; content is
      never merged across a known previous turn.
- [x] Turns longer than the window degrade to a partial summary with no tool-success
      evidence and `conversation`, never an unverified `agent_action` claim.
- [x] Deprecated synchronous snapshot access is kept bounded; a future async stream is noted
      but host integration was not redesigned.
- [x] Reasoning, tool text, system/plugin injection, plans and non-user sources excluded.
- [x] Malformed/non-object user sources fail closed; only absent/null is a legacy exception.
- [x] Only an explicitly non-error tool result supports `agent_action`; unknown status is
      `conversation` and tool success is never invented.
- [x] Bounded extractive topic/outcome snippets, no long-message copies, no LLM; duplicate
      turn/end dedupe, TTL/row caps.
- [x] Default self; exact shared allowlist; Host-authenticated owner callback default false.
- [x] Every shared target is gated before policy write; read-time checks remain authoritative.
- [x] Source and target Workspace membership checked; revoke/disable/move affects the next read.
- [x] Session name/preset/model/arguments never authorize; no raw cross-Session logs.
- [x] Read applies policy/TTL/gate before ranking; safe DTO with estimated tokens.
- [x] Explicit self query allowed; self can be omitted for auto-injection.
- [x] Required tests written and passing on temporary SQLite only.
- [x] Module `lib` copy matches source; no web search, external/child agents, commits or
      production files.
