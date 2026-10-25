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
- `dsh-mneme/lib/identity.js` (generated)
- `dsh-mneme/lib/preferences.js` (generated)
- `dsh-mneme/lib/intake.js` (generated)
- `dsh-mneme/docs/AMADEUS_MEMORY_ENHANCER.md`
- `dsh-mneme/scripts/memory-enhancer-fixture.mjs`
- `dsh-mneme/scripts/benchmark-memory-enhancer.mjs`
- `dsh-mneme/reports/memory-enhancer-benchmark.json` (measured output, synthetic)
- `dsh-mneme/test/identity.test.js`
- `dsh-mneme/test/preferences.test.js`
- `dsh-mneme/test/trusted-intake.test.js`
- `dsh-mneme/test/memory-enhancer-api.test.js`
- `dsh-mneme/test/memory-enhancer-retrieval.test.js`
- `docs/verification/MEMORY_ENHANCER_WORKER.md` (this file)

No Life code, production profile/database, credentials, real chat/memory, or
private QQ identifiers were touched or included. Synthetic identifiers only.

## Validation

Commands run from `dsh-mneme/`.

- `npm install --ignore-scripts --cache <workspace cache>` — local dependency
  install (postinstall scripts blocked by the file sandbox; no production
  install).
- `node scripts/check-sync.js` — PASS: `src/` and `lib/` byte-identical
  (79 files; `lib/client.js` is lib-only by design).
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
| `test/preferences.test.js` | 7 | PASS |
| `test/trusted-intake.test.js` | 6 | PASS |
| `test/memory-enhancer-api.test.js` | 10 | PASS |
| `test/memory-enhancer-retrieval.test.js` | 5 | PASS |

### Full suite

Bounded per-file sweep after the Codex review fixes (179 test files,
`Start-Job`, 180 s/file timeout; raw result
`.benchmark/full-test-results-review.json`):

- 2314 tests observed, 2278 passed, 35 failed, 1 file timed out.
- After the sweep, two bounded tests were added (`test/identity.test.js` now
  15/15, `test/memory-enhancer-api.test.js` now 10/10); no failing file changed,
  so the aggregate would be 2316 tests with the same 35 environmental/baseline
  failures and the one sandbox timeout.
- The only timeout is `test/mcp-stdio.test.js` (spawns a stdio MCP child with
  pipes; the DSH file sandbox blocks that).
- Every failing file was re-run from the import-baseline checkout and produced
  the same failures (counts below are baseline → implementation):
  - `capabilities.test.js` 20/21 → 20/21 (Windows symlink privilege)
  - `client.test.js` 79/80 → 79/80 (parse test shells out with `spawnSync` → EPERM;
    direct `node --check lib/client.js` passes)
  - `maintenance.test.js` 12/14 → 12/14 (CLI `execFile` → EPERM)
  - `peer-blockers.test.js` 5/6 → 5/6 (multi-process spawn → EPERM)
  - `pipeline-runner.test.js` 21/22 → 21/22 (pre-existing fixture failure)
  - `pipeline.test.js` 19/32 → 19/32 (repo lacks `pipelines/` and `.mneme/`)
  - `publish-gate.test.js` 14/15 → 14/15 (child-process EPERM)
  - `readme-claims.test.js` (root README lacks the upstream privacy sections)
  - `release-notes.test.js` 14/17 → 14/17 (child-process EPERM)
  - `serve-bin.test.js` 0/2 → 0/2 (spawn EPERM)
  - `session-usage.test.js` 11/12 → 11/12 (Windows symlink privilege)
  - `test-count-sync.test.js` 3/4 → 3/4 (root README has no test badge)
  - `workflow-guards.test.js` 0/7 → 0/7 (`.github/workflows/` not imported)
  - `security-doc.test.js` cannot load: repository root has no `SECURITY.md`
    in this baseline.
- `test/lib-smoke.test.js` failed once because `src/` and `lib/` drifted during
  the final edit; after `npm run sync` it passes 6/6. No other regression was
  introduced by the enhancer.

Supervisor checkpoint: an independent parse of the same bounded run counted 179
files with 178 completed and only `mcp-stdio.test.js` timing out. The
test-level failures above are the known baseline/environmental ones, not
enhancer regressions.

Post-review affected-file rerun (all green):

```
identity 15/15 · preferences 7/7 · trusted-intake 6/6 · enhancer-api 10/10
enhancer-retrieval 5/5 · api 76/76 · route-policy 6/6 · lib-smoke 6/6
tools-dto-schema-matrix 7/7 · entities 39/39
```

`node --check lib/client.js` — PASS. `node scripts/check-sync.js` — PASS.
`git diff --check` — PASS (only LF→CRLF warnings).

## Benchmark (measured, synthetic)

Command:

```bash
mkdir -p .benchmark/baseline
git -C .. archive --format=tar 13e6520:dsh-mneme | tar -xf - -C .benchmark/baseline
node scripts/benchmark-memory-enhancer.mjs --baseline .benchmark/baseline \
  --runs 3 --iterations 20 --json .benchmark/benchmark-result.json
```

Measured summary (3 runs, 20 iterations):

| Metric | Import baseline | Implementation |
|---|---|---|
| Recall@5 | 0.3333 | 0.8492 |
| MRR | 0.3333 | 1.0000 |
| p50 search latency | 3.782 ms | 4.854 ms |
| p95 search latency | 5.217 ms | 7.092 ms |
| DB file size | 344,064 B | 475,136 B |
| Heap delta | 992,859 B | 2,813,715 B |
| Background LLM calls | 0 | 0 |

The fixture is synthetic (50 memories, fake QQ group number): heavy casual
group chatter, sparse close-person events, own actions, old important memories,
and irrelevant high-weight memories. The benchmark measures keyword/BM25/graph
retrieval with no embedder/reranker; it does not model production volume,
concurrency, embeddings or real query distributions. Background LLM calls are 0
because no provider/extractor/dream/summarize hook is installed in either mode.
See `docs/AMADEUS_MEMORY_ENHANCER.md` for dataset and limitations.

## Known limitations / review notes

- Identity suggestions use names/aliases/typed IDs only; embeddings never
  trigger a merge. Shared nicknames can remain ambiguous by design.
- Confirmed alias uniqueness is global per normalized alias; a real duplicate
  nickname needs distinct labels or stays unconfirmed.
- A name-only person/group write is deliberately unresolved when a candidate
  exists; the extractor records it as `unresolved` and writes no attrs/relations.
  Existing legacy name aliases are unconfirmed, so operators must confirm a
  binding (or supply a trusted external ID) to reuse them.
- Cross-platform same-type association is manual only (dry-run + confirm);
  same-platform different IDs never merge; person/group never merge.
- All new identity/preference/provenance routes require an actually configured
  server `apiToken`; without one they return 503 instead of legacy fail-open.
- Undo with dependent links is refused until dependents are undone.
- Preference reranking costs a larger candidate pool (latency/size measured
  above); it is off by default.
- `trustedIntakeEnabled` requires `apiToken`; intake returns 503 without it
  rather than using Mneme's legacy fail-open write behavior.
- `node test/*.test.js` direct execution is used because the sandboxed
  `node --test` runner spawns child processes (`EPERM`).
- The full suite includes the environmental failures listed above; none of the
  new/affected tests failed.

## DSH usage / duplicated work

- The runtime does not expose exact prompt/completion token counters to the
  worker, so a precise token figure cannot be reported. The session used
  roughly 300 model-visible steps, a large share spent reading the 1.5 MB+
  package sources, debugging sandbox limitations, and the Codex review fixes.
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
