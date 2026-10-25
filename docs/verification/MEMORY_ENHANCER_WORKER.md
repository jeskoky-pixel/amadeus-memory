# Amadeus Memory Enhancer — DSH Creator worker report

Date: 2026-10-25 (Asia/Shanghai)

Branch: `codex/memory-enhancer`
Workspace: isolated development workspace `amadeus-memory`
Baseline: `dsh-mneme/` imported from `slow-stack/mneme` main
`146fa3657dbb73c0498aba969977e7c14e13684a` (import commit `13e6520`).

Codex owns architecture, final review, Git commits, PR and acceptance. This
worker did not commit, push, publish, install into DSH, or touch the live
profile/database.

## Scope delivered

1. Stable identity: typed external IDs, aliases with provenance/confirmation/
   active state, reversible canonical links, append-only audit, legacy-name
   seeding, deterministic QQ group parsing, strict type/platform boundaries.
2. Non-destructive dedup: candidate suggestions only; persisted dry-run report;
   confirm/undo; canonical view used by directory, graph, retrieval, memory
   entities, attrs, counts.
3. Preference weights: tag and canonical-entity CRUD, opt-in flag, bounded
   combination/clamp, relevance floor, integration with keyword/vector/BM25/
   graph/explicit entity/injection, explanatory signals.
4. Trusted own-experience intake: authenticated route, explicit scope, source/
   actor/participation/status validation, deterministic event tags, SQLite
   provenance, normal save/dedupe/archive/forget path.
5. Native UI: Chinese/English tag and entity weights, duplicate candidates,
   dry-run/confirm/undo, aliases, external IDs, canonical members/history,
   relation weight/source, preference contribution; entity selection by UUID.
6. Tests, synthetic retrieval fixture, measured baseline/implementation
   benchmark, docs, sync and validation.

## Codex review revision (2026-10-25)

Fixed concrete review findings:

1. **Same-name identity collision (P0).** `resolveEntityForWrite` now treats a
   new/unclaimed `(platform, entity_type, external_id)` as a separate entity; it
   never inherits an existing name/nickname match. Same ID + different nickname
   reuses the UUID and records an observed alias. Name-only person/group/unknown
   writes return `name-only-unresolved` unless an explicit confirmed alias binds
   them. QQ numeric groups keep deterministic parsing; `qq/person/12345` and
   `qq/group/12345` are separate identities. Different same-platform IDs stay
   separate; cross-platform same-type association remains manual (dry-run +
   confirm) and person/group remains a hard barrier.
2. **API disclosure / fail-open (P0).** All new identity, candidate, link,
   history, entity-detail, preference and provenance reads/writes are
   `policy:"token"` **and** return `503 api-token-required` when the server has
   no configured token. Legacy open `/entities`, graph ego, entity-attrs and
   memory-entities endpoints were redacted back to their pre-enhancement shapes;
   private aliases/external IDs/member UUIDs/evidence/provenance are served only
   by token routes. The panel shows a setup state when the token is absent.
3. **Stale merge report (P1).** Impact reports now include a deterministic
   SHA-256 fingerprint over entity/group membership, attrs, relations
   (source/weight), aliases, external IDs, active links, conflicts and blockers.
   `confirmMerge` re-evaluates it inside `BEGIN IMMEDIATE` and rejects any changed
   input as `stale-report`; repeated confirm/undo is rejected deterministically.
4. **Scale (P1).** One request snapshot reads entities/links/aliases/external IDs
   in four queries; groups are built in memory. Duplicate candidates use exact
   name/alias/typed-ID blocks plus a bounded trigram similar-name path instead of
   all-pairs similarity. Added a 3,000-entity query-count assertion. Graph ego
   BFS now batches its group lookup and canonicalizes relations through a
   one-query link index, so the existing 2-hop performance guard stays green.
5. **Legacy organization-typed QQ groups.** Migration now recognizes the
   deterministic QQ numeric names even when the old extractor labeled them
   `organization`, reclassifies them to `group`, preserves the previous type in
   audit/evidence, seeds typed IDs for unique numbers, and records duplicate
   numbers as manual-merge candidates without auto-linking. Person-typed rows
   are never reclassified.
6. **Entity directory pagination.** `GET /entities` now returns a bounded page
   (`limit` ≤1000, default 500, `offset`, optional `q`) with the true filtered
   `total` and `has_more`; the legacy redacted row shape is unchanged. The panel
   uses server-side paging/search and a "load more" control, so a long-lived
   graph remains fully reachable without loading thousands at once. Added a
   1,205-entity API regression covering both pages, total, has_more and search.
7. **Alias/external-ID probing (P0).** Public directory `q` filters only public
   display names. Open graph ego/entity-attrs and the open `/search?q=entity:`
   prefix resolve only a public UUID or the exact public display name. Open
   ordinary search also passes `publicOnly` into graph-recall fusion, so a
   private alias absent from memory text cannot seed a graph-linked memory.
   Aliases and typed external IDs resolve only on authenticated identity routes
   or internal/model retrieval. Added regression probes proving a secret
   alias/external ID matches none of the open endpoints while `/entities` still
   finds the public name, UUID entity search and public display-name graph recall
   still work, internal retrieval keeps full alias graph recall, and
   authenticated entity-detail still works.

## Quality repair (Codex acceptance round 2, 2026-10-25)

1. **Trusted event authenticity (P0).** `src/trusted-events.js` centralizes
   NFKC/case-insensitive `event:*` namespace checks. Ordinary save/update strips
   every event spelling, including unknown future tags and `source=trusted_intake`
   spoofing. Only a closure-private `writeTrustedIntake` channel can add the tag
   derived from a validated kind. Ordinary updates and title-dedupe merges union
   the event tags backed by committed `memory_trusted_provenance`; extra
   event tags on intake are rejected before any write. Standalone save/update and
   tool/MCP paths inherit the same service guard. Read-time preference scoring
   and API/tool claim display also ignore legacy unbacked event tags (including
   Unicode variants) unless provenance backs the exact kind; no DB rewrite is
   performed.
2. **Durable request-id idempotency (P1).** Additive
   `memory_trusted_requests` table keyed by normalized actor + request id, with a
   SHA-256 fingerprint of material payload. Same key/payload replays the original
   memory/provenance; same key/different payload returns `409
   request-id-conflict`; distinct IDs with the same title force-new and remain
   distinct. Check+write runs under `BEGIN IMMEDIATE`; memory, provenance and
   request row roll back together. Old DBs with duplicate historical request IDs
   are safe because no unique index is added to legacy provenance rows. The
   regression uses two barrier-synchronized worker-thread connections for a
   genuinely overlapping submission, not a sequential retry.
3. **Pending identity continuity (P1).** Unresolved name-only assertions persist
   with source memory, attrs, candidate IDs and evidence in
   `identity_pending_assertions`. Relations with at least one unresolved endpoint
   persist separately in `identity_pending_relations` with endpoint names/types,
   any already-resolved UUIDs and source memory. Each confirmation retries them;
   a relation is written only when both endpoints are unambiguous and type
   boundaries hold. Endpoint UUIDs come from a stored resolution, the confirmed
   alias, or explicit per-source selection — never a bare name. Two stable-ID
   people sharing a name stay pending until explicit selection. Applied relations
   are reused on re-extraction (no duplicate edge). Alias confirmation and
   recovery share one transaction: a failed recovery rolls back the confirmation,
   retains pending rows and surfaces `pending-recovery-failed` (regression injects
   a SQLite trigger abort). Source memory must exist and not be forgotten; stale
   sources are marked `stale`/audited rather than resurrected, and explicit
   selection returns `pending-source-unavailable`. Pending assertion payloads are
   bounded (40 attrs, 40 relations, 16 KiB, plus a 100-relation extractor cap)
   and marked `truncated`. The focused regression now covers a two-pending-person
   relation (including restart), duplicate-free re-extraction, same-name
   stable-ID ambiguity plus explicit selection, and forgotten-source relation
   staleness.
4. **Preference ablation (P1).** Benchmark now runs A original, B enlarged pool
   with neutral weights, C tag-only, D tag+entity, plus all-1.0 control. B uses a
   test-only `__preferenceAblationPoolOnly` gate (not a product config key).
   Measured: B equals A (0.3333 Recall@5 / 0.3333 MRR), C and D both 0.8492 /
   1.0; pool expansion alone does not improve this fixture, tag weights drive the
   measured gain, and entity weights add no measurable gain here.
5. **Read-only model tools.** `memory_preference_get` exposes the current
   preference state (bounds, Tag weights, canonical-entity weights) without any
   mutation path; both weight lists are capped at 200 with explicit truncation
   flags. `memory_identity_lookup` accepts an exact name/alias or UUID and uses
   the existing identity read APIs to return the canonical UUID/type/name,
   aliases, member IDs and a bounded relation summary (20 items, 10 candidates,
   50 aliases/members). Same-name candidates stay ambiguous; unresolved names
   return no entity. It never matches external IDs, confirms aliases, merges,
   writes provenance, or creates entities. Both tools keep the existing tool
   registration/disable behavior; with `organizeEnabled` off the registry now
   has 13 tools (14 with organize). Both are hidden when `strictScope` is on,
   because their library-wide names do not carry per-session scope labels.

## Files changed

Modified:

- `dsh-mneme/.gitignore`
- `dsh-mneme/README.md`
- `dsh-mneme/docs/CONFIGURATION.md`
- `dsh-mneme/docs/ENTITIES.md`
- `dsh-mneme/lib/api.js` (generated from `src/api.js`)
- `dsh-mneme/lib/client.js` (hand-authored panel, both locales)
- `dsh-mneme/lib/config.js` (generated)
- `dsh-mneme/lib/entities/extractor.js` (generated)
- `dsh-mneme/lib/index.js` (generated)
- `dsh-mneme/lib/service.js` (generated)
- `dsh-mneme/lib/settings.js` (generated)
- `dsh-mneme/lib/store.js` (generated)
- `dsh-mneme/lib/tools.js` (generated)
- `dsh-mneme/src/api.js`
- `dsh-mneme/src/config.js`
- `dsh-mneme/src/entities/extractor.js`
- `dsh-mneme/src/index.js`
- `dsh-mneme/src/service.js`
- `dsh-mneme/src/settings.js`
- `dsh-mneme/src/store.js`
- `dsh-mneme/src/tools.js`
- `dsh-mneme/test/api.test.js` (feature-flag count 106 → 108)

Added:

- `dsh-mneme/src/identity.js`
- `dsh-mneme/src/preferences.js`
- `dsh-mneme/src/intake.js`
- `dsh-mneme/src/trusted-events.js`
- `dsh-mneme/lib/identity.js` (generated)
- `dsh-mneme/lib/preferences.js` (generated)
- `dsh-mneme/lib/intake.js` (generated)
- `dsh-mneme/lib/trusted-events.js` (generated)
- `dsh-mneme/docs/AMADEUS_MEMORY_ENHANCER.md`
- `dsh-mneme/scripts/memory-enhancer-fixture.mjs`
- `dsh-mneme/scripts/benchmark-memory-enhancer.mjs`
- `dsh-mneme/reports/memory-enhancer-ablation.json` (measured four-arm output)
- `dsh-mneme/reports/memory-enhancer-benchmark.json` (earlier measured output)
- `dsh-mneme/test/identity.test.js`
- `dsh-mneme/test/preferences.test.js`
- `dsh-mneme/test/trusted-intake.test.js`
- `dsh-mneme/test/memory-enhancer-api.test.js`
- `dsh-mneme/test/memory-enhancer-retrieval.test.js`
- `dsh-mneme/test/memory-enhancer-quality-regressions.test.js` (Codex red tests, unmodified)
- `dsh-mneme/test/memory-enhancer-quality-extra.test.js`
- `dsh-mneme/test/memory-enhancer-tools.test.js`
- `dsh-mneme/test/memory-enhancer-identity-continuity.test.js` (Codex red test, unmodified)
- `docs/verification/MEMORY_ENHANCER_WORKER.md` (this file)

No Life code, production profile/database, credentials, real chat/memory, or
private QQ identifiers were touched or included. Synthetic identifiers only.

## Validation

Commands run from `dsh-mneme/`.

- `npm install --ignore-scripts --cache <workspace cache>` — local dependency
  install (postinstall scripts blocked by the file sandbox; no production
  install).
- `node scripts/check-sync.js` — PASS: `src/` and `lib/` byte-identical
  (80 files; `lib/client.js` is lib-only by design).
- `node test/<file>.js` for the new tests — PASS (see counts below).
- Full suite with a per-file timeout runner (`Start-Job`, 150 s/file). Results
  and environmental failures are recorded below.
- `git diff --check` — PASS (only Git LF→CRLF warnings; no whitespace errors).
- `node --check dsh-mneme/lib/client.js` — PASS (standalone parse check; the
  in-suite parse test spawns a child and cannot run under this file sandbox).

### New tests

| File | Tests | Result |
|---|---|---|
| `test/identity.test.js` | 15 | PASS |
| `test/preferences.test.js` | 8 | PASS |
| `test/trusted-intake.test.js` | 6 | PASS |
| `test/memory-enhancer-api.test.js` | 11 | PASS |
| `test/memory-enhancer-retrieval.test.js` | 5 | PASS |
| `test/memory-enhancer-quality-regressions.test.js` (Codex) | 10 | PASS |
| `test/memory-enhancer-quality-extra.test.js` | 12 | PASS |
| `test/memory-enhancer-tools.test.js` (read-only tools) | 8 | PASS |
| `test/memory-enhancer-identity-continuity.test.js` (Codex) | 3 | PASS |
| `test/standalone-api.test.js` (spoof addition) | 30 | PASS |

### Full suite

The bounded full sweep below was run before the final focused pending-relation
fix; per Codex instruction it was not rerun for that narrow change. The focused
identity/API/regression files were rerun and are listed below.

Final bounded per-file sweep after the quality repair (182 test files,
`Start-Job`, 180 s/file timeout; raw result
`.benchmark/full-test-results-quality.json`):

- **2339 tests observed, 2303 passed, 35 failed, 1 file timed out.**
- The only timeout is `test/mcp-stdio.test.js` (spawns a stdio MCP child with
  pipes; the DSH file sandbox blocks that).
- Every failing file is a known environmental/baseline limitation:
  - `capabilities.test.js` 20/21 (Windows symlink privilege)
  - `client.test.js` 79/80 (parse test shells out with `spawnSync` → EPERM;
    direct `node --check lib/client.js` passes)
  - `maintenance.test.js` 12/14 (CLI `execFile` → EPERM)
  - `peer-blockers.test.js` 5/6 (multi-process spawn → EPERM)
  - `pipeline-runner.test.js` 21/22 (pre-existing fixture failure)
  - `pipeline.test.js` 19/32 (repo lacks `pipelines/` and `.mneme/`)
  - `publish-gate.test.js` 14/15 (child-process EPERM)
  - `readme-claims.test.js` 2/3 (root README lacks upstream privacy sections)
  - `release-notes.test.js` 14/17 (child-process EPERM)
  - `serve-bin.test.js` 0/2 (spawn EPERM)
  - `session-usage.test.js` 11/12 (Windows symlink privilege)
  - `test-count-sync.test.js` 3/4 (root README has no test badge)
  - `workflow-guards.test.js` 0/7 (`.github/workflows/` not imported)
- Two mid-repair regressions were found by earlier sweeps and fixed rather than
  left in the baseline column:
  - `api-routes-gaps.test.js` failed because `/entities` always added pagination
    metadata. Fixed by returning the exact legacy `{entities,total}` shape when
    no `limit`/`offset`/`q` is supplied; now 30/30.
  - `memory-enhancer-quality-extra.test.js` once timed out under the nested sweep
    runner because the worker-thread barrier had no readiness/result timeout.
    Added error propagation, 20 s phase timeouts, three fresh-DB attempts and
    cleanup; five consecutive Start-Job stress runs passed, and the final sweep
    passed 8/8.
- No enhancer test failed in the final sweep. The 35 failures and one timeout
  match the previously documented baseline/environmental set.

Post-repair affected-file rerun (all green):

```
quality-regressions 10/10 · quality-extra 12/12 · identity-continuity 3/3
preferences 8/8 · trusted-intake 6/6 · enhancer-api 11/11
enhancer-tools 8/8 · tools 30/30 · tools-dto-matrix 7/7
standalone-api 30/30 · api 76/76 · api-routes-gaps 30/30
route-policy 6/6 · service-search 8/8 · inject 28/28 · lib-smoke 6/6
```

`node --check lib/client.js` — PASS. `node scripts/check-sync.js` — PASS.
`git diff --check` — PASS (only LF→CRLF warnings).

## Preference ablation (measured, synthetic)

Command:

```bash
mkdir -p .benchmark/baseline
git -C .. archive --format=tar 13e6520:dsh-mneme | tar -xf - -C .benchmark/baseline
node scripts/benchmark-memory-enhancer.mjs --baseline .benchmark/baseline \
  --runs 3 --iterations 20 --json .benchmark/benchmark-ablation.json
```

Arms: A original baseline; B enlarged pool + neutral weights; C tag weights
only; D tag + canonical-entity weights; all1 = flag on, every weight 1.0. B uses
the test-only `__preferenceAblationPoolOnly` gate (not a product config key).
Current arms seed event-tagged fixture rows via trusted intake so the labels are
provenance-backed; A keeps the baseline's historical unbacked labels.

| Arm | Recall@5 | MRR | p50 | p95 | DB bytes |
|---|---|---|---|---|---|
| A original | 0.3333 | 0.3333 | 5.595 ms | 8.013 ms | 344,064 |
| B pool only | 0.3333 | 0.3333 | 5.686 ms | 7.985 ms | 507,904 |
| C tag weights | **0.8492** | **1.0000** | 7.155 ms | 11.407 ms | 507,904 |
| D tag+entity | **0.8492** | **1.0000** | 6.925 ms | 10.619 ms | 507,904 |
| all1 control | 0.3333 | 0.3333 | 5.227 ms | 7.210 ms | 507,904 |

Per-query expected-ID ranks for run 1 are in
`reports/memory-enhancer-ablation.json`. Honest result: pool expansion alone did
not improve this fixture (B = A); bounded tag weights produced the measured gain;
entity weights added no measurable Recall@5/MRR gain here. All arms made 0
background LLM calls. The fixture is synthetic (50 memories, fake QQ group
number): chatter, sparse close-person events, own actions, old important
memories, irrelevant high-weight rows. It does not model production volume,
concurrency, embeddings or real query distributions.

## Known limitations / review notes

- Identity suggestions use names/aliases/typed IDs only; embeddings never
  trigger a merge. Shared nicknames can remain ambiguous by design.
- Confirmed alias uniqueness is global per normalized alias; a real duplicate
  nickname needs distinct labels or stays unconfirmed.
- A name-only person/group write is deliberately unresolved when a candidate
  exists; the extractor persists a pending assertion and writes no attrs/relations.
  A single safe candidate is recovered after human alias confirmation; ambiguous
  candidates require explicit `POST /identity/pending` selection. Relations whose
  other endpoint remains unresolved are not guessed during recovery.
- `source=trusted_intake` is descriptive, not authority. Event tags are minted
  only by the closure-private intake writer, which is backed by committed
  provenance. Ordinary save/update strips every NFKC/case `event:*` spelling,
  including unknown future tags.
- Cross-platform same-type association is manual only (dry-run + confirm);
  same-platform different IDs never merge; person/group never merge.
- All new identity/preference/provenance routes require an actually configured
  server `apiToken`; without one they return 503 instead of legacy fail-open.
- Undo with dependent links is refused until dependents are undone.
- Preference reranking costs a larger candidate pool (latency/size measured
  above); it is off by default.
- `trustedIntakeEnabled` requires `apiToken`; intake returns 503 without it
  rather than using Mneme's legacy fail-open write behavior.
- `request_id` idempotency is scoped by normalized `actor` (the shared API token
  does not identify Life instances). Same key must be retried with the same
  material payload; different material returns 409. Historical duplicate
  provenance request IDs are preserved without a unique index.
- `node test/*.test.js` direct execution is used because the sandboxed
  `node --test` runner spawns child processes (`EPERM`).
- The full suite includes the environmental failures listed above; none of the
  new/affected tests failed.

## DSH usage / duplicated work

- The runtime does not expose exact prompt/completion token counters to the
  worker, so a precise token figure cannot be reported. The session used
  roughly 360 model-visible steps, a large share spent reading the 1.5 MB+
  package sources, implementing the Codex red-test contract, running bounded
  per-file sweeps, and hardening concurrency/recovery tests.
- No child agents or extra sessions were spawned.
- Duplicated/wasted work:
  - one full dependency install attempt failed on the default npm cache outside
    the workspace; re-run with a workspace cache and `--ignore-scripts`;
  - one `node --test` run failed because the runner spawns child processes; the
    suite was run file-by-file instead;
  - one per-file timeout loop used `Start-Process` and produced false timeouts
    because no child was launched under the sandbox; replaced with `Start-Job`.
- Nothing was committed; Codex should review the working tree.

## Reproduce checks

```bash
cd dsh-mneme
npm run sync
node scripts/check-sync.js
node test/identity.test.js
node test/preferences.test.js
node test/trusted-intake.test.js
node test/memory-enhancer-api.test.js
node test/memory-enhancer-retrieval.test.js
node --check lib/client.js
```
