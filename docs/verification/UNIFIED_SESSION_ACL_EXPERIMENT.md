# Unified Session ACL experiment (in progress)

This branch is an opt-in architecture experiment. It is not an installable
replacement for the v1.2.0 candidate. Do not enable unified ACL on a user
database or install this branch in the daily DSH Profile.

## Frozen baseline

- PR #6 head and baseline branch `backup/amadeus-memory-pre-unified-session-acl`:
  `d1c1aa405ad12092ac125ee00798476a5069d07b`.
- Baseline package: `@fg-lab/amadeus-memory@1.2.0`, SHA-256
  `2FD41422A6FA30B60975FF8B306BCFECB80F39DA3CACDAB84FF72B0ADC3AC392`.
- Baseline schema: `PRAGMA user_version = 1`.
- Baseline quality gate: 725 passed, 0 failed, 0 skipped.
- Experimental branch quality gate at this checkpoint: 753 passed, 0 failed,
  0 skipped. This validates only the implemented foundation, not the full
  architecture or real Desktop behavior.
- The frozen package installed into a new `memory-acl-lab` DSH Profile. That
  bare Profile lacks `webServer`, so a GUI/runtime boot is not yet validated.
- A synthetic schema-v1 SQLite library passed `quick_check`. Copying it and
  reopening with the frozen package's `lib/store.js` retained the test memory
  and graph-capable schema. This is a code/database rollback smoke test, not a
  DSH Desktop rollback rehearsal.
- The baseline source branch and package must remain available throughout this
  experiment. No live Profile or user database is part of this branch.

## Source and authorization model

The existing `memories` table and Mneme entity tables remain global within the
selected Workspace. A stable source key is `qq:<kind>:<bot>:<peer>` for a Host
verified QQ Scene and `dsh:session:<id>` for an ordinary Host Session. A QQ
Session rebuilt with a new ID can retain its verified source key. An ordinary
Session never inherits by title. A changed Host binding for an existing ID is
rejected instead of silently reclassifying a source.
When a QQ Host is present but cannot bind a Session, the experimental core now
requires a separate trusted `confirmOrdinarySession` decision. A custom preset
alone is insufficient because a renamed QQ Session may be paused or temporarily
unbound. The current QQ Host contract does not yet provide this negative proof;
the runtime mode must stay unavailable until that gap is resolved without a
fixed Agent Preset whitelist.

`unified_memory_sources` records each source for a memory. All linked sources
must be readable before the memory can be returned. A single grant never opens
the text of a mixed-source memory. Existing QQ rows may derive their source
from the preserved `scene_scope`; untagged legacy rows remain quarantined until
reviewed. No old row is rewritten by opening the ACL module.

Long-term grants are directional and non-transitive. The reader's own source
is always visible. `owner_read` is separate from direct grants and requires a
verified Owner private Scene at read time. Recent-activity policies remain in
their existing tables and must not be inferred from these grants. Revocation
is read from SQLite on each check; no policy cache is retained.

## Required integration before the feature may be enabled

1. Add the default-off `unifiedSessionAclEnabled` switch to config and settings
   only when every model read/write path is gated. A stored true value must not
   be able to activate an incomplete implementation.
2. Resolve the runtime Session from Host services; authorize Workspace
   membership and QQ Scene at every model invocation. Supply a trustworthy
   ordinary-Session classification for custom Agent Sessions when QQ is present.
   Never trust HTTP or tool arguments for source identity.
3. Stamp new writes and their source link in one SQLite transaction. Constrain
   dedupe, updates, provenance, and background merges to one source unless all
   contributions can be represented and checked.
4. Apply source predicates in SQL before keyword, BM25, vector candidate limits
   and reranking. Apply the same predicate before automatic injection.
5. Filter entity names, aliases, attributes, relation evidence, neighbor
   traversal, counts, and graph hints before model-visible computation. An
   evidence-less legacy edge is hidden from ordinary Sessions.
6. Partition autoSummarize, Dream, and Sleep by source, or explicitly suspend
   an unsafe task while this mode is on. Existing Scene job partitioning is a
   useful starting point, but its legacy bucket cannot become public.
7. Build an authenticated admin API and the fifth-page Session controls. The
   original four Mneme pages and entity graph must remain intact. A graph
   preview must use the model's exact visibility predicate.
8. Run isolated DSH Desktop and synthetic database tests, including restart,
   migration failure, rollback, and P50/P95 old-versus-new latency.

Current runtime entry points: `src/tools.js` tool execution, `src/inject.js`
prompt render, `src/summarize.js` distillation, `src/service.js` search and
write, `src/store.js` SQL candidates, `src/index.js` Dream/Sleep scheduling,
and `src/identity.js` graph resolution. The present Scene filter in
`src/service.js` runs after some graph and recall work, so extending only that
final filter is insufficient.

## Rollback levels

- **Config:** turn off the new flag only after verifying that no new-format
  writes must be kept. This retains the current database.
- **Code:** stop the experimental plugin, reinstall the frozen package, and
  restart DSH. This alone does not prove the old code can read a migrated DB.
- **Database:** preserve the failed snapshot, restore the pre-experiment SQLite
  snapshot including WAL consistency, then reinstall the frozen package and
  verify memory count/content, graph evidence, Scene isolation, and GUI.

Any experimental memories needing preservation require an isolated export and
manual source review before import. No automatic reverse migration is claimed.

## Current result

### Preliminary SQL and graph cost

In-memory SQLite on Windows, Node 22, one synthetic Session and 30 warm
samples per operation. All memories had a distinct linked entity and a 2D
synthetic embedding. These are
microbenchmarks of the store layer, not full DSH/LLM latency. They precede the
latest per-read Host identity revalidation and must be rerun before a performance
decision.

| Rows | Operation | Baseline P50/P95 ms | ACL context P50/P95 ms |
| ---: | --- | ---: | ---: |
| 1,000 | Entity list | 1.373 / 1.822 | 2.674 / 2.895 |
| 1,000 | Graph name lookup | 5.470 / 7.563 | 3.672 / 5.126 |
| 1,000 | Keyword search | 0.716 / 1.108 | 1.317 / 1.442 |
| 1,000 | Vector search | 0.708 / 2.923 | 1.266 / 1.507 |
| 1,000 | Memory list | 0.438 / 0.532 | 0.997 / 1.145 |
| 10,000 | Entity list | 17.974 / 19.888 | 37.636 / 41.003 |
| 10,000 | Graph name lookup | 69.935 / 80.618 | 47.909 / 54.629 |
| 10,000 | Keyword search | 6.701 / 7.638 | 14.930 / 16.005 |
| 10,000 | Vector search | 65.739 / 79.951 | 64.076 / 81.947 |
| 10,000 | Memory list | 3.611 / 4.647 | 10.905 / 11.464 |

The ACL adds approximately 1.9–3.0x to list and keyword store calls. Vector
search was similar at 10,000 rows, and graph name lookup was faster because
the experimental view omits unevidenced aliases and external IDs. The latter
is not a like-for-like feature comparison. Multi-hop, full retrieval,
background tasks and LLM cost have not been measured. The entity-name evidence
predicate may need an index or materialized evidence table before acceptance.

The standalone ACL core and synthetic tests cover trusted identity, QQ rebuild,
legacy quarantine, source-conjunctive reads, directional grants, Owner policy,
revocation, schema reopen, and write rollback. Within a trusted execution
context, the Mneme store now stamps a source and filters list, keyword, vector,
count, and direct-ID lookups before candidate limits. Evidence-linked entity
attributes, relations and neighbor reads are filtered; the provisional model
view omits aliases, external IDs and canonical merges without source evidence.
The canonical-link suppression is a deliberate safety limitation: separately
named nodes merged by the administrator will still appear separate to model
Sessions until the link itself has an evidence-aware visibility design.
The latest local regression tests also cover cross-ACL identity rejection,
Host/Workspace revocation during execution, same-source dedupe, read-only grant
enforcement on memory/graph mutations, and source-private quality/dedupe
candidate sampling. These are not a substitute for all model and background
entry points. Service-level regression tests also confirm that a source's
semantic recall cache cannot enter another Session's injection, that a direct
long-term read grant and revocation affect service search, and that Host
revocation during asynchronous reranking prevents the result from returning.
The context is
not yet connected to DSH model execution, and the complete graph path, GUI,
Dream/Sleep and performance comparison have not been safely integrated.
Therefore the unified architecture has **not** met the acceptance standard and
cannot replace the baseline.


## Phase 2 safety checkpoint — 2026-10-30

**Partial implementation, not runtime acceptance. Keep PR #7 Draft and the
experiment inactive.** No installed Profile or database was modified.

### Reproduced and repaired

The new asynchronous grant-revocation test failed on the starting commit:
three rows were returned although only two remained authorized. Search now
uses the existing per-row SQLite visibility predicate after asynchronous
ranking, before the recall receipt, shared-cache decision and model return.
The regression also checks injection and evidence-backed attributes/relations;
the reader's own rows and an unrelated valid grant remain readable.

Separate tests cover Session deletion, Workspace revocation, QQ rebinding,
Owner loss, and two overlapping searches completed across revoke/regrant.
Revocation affects future retrieval; it cannot erase text already delivered
to a model or already present in conversation history. No new ACL epoch or
in-memory grant cache was introduced.

The new graph-management regression also failed on the starting commit.
Model execution can no longer rename/retype shared entities, replace canonical
memory references, manage global aliases/external IDs, confirm/undo merges,
or recover globally pending identity facts by supplying an `actor` string.
Global management continues to work outside model execution for the existing
authenticated administrator surface. This is not an authentication mechanism
for arbitrary callers: runtime entrypoint coverage remains mandatory.

Attribute invalidation selects only owned memory evidence, ignoring a forged
source selector. Attribute migration checks both memories; relation weight
changes check their supporting memory. Pending assertions/relations cannot
be attached to another source's memory. Direct global identity history/list
APIs no longer bypass the conservative model view. Model entity DTOs omit
global counts/timestamps/canonical-memory pointers; model name lists do not
rank by private global sighting time.

Conservative limitation: model extraction does not create global aliases or
stable-ID bindings. New name-based entities and owned fact evidence remain
possible. Stable-ID and canonical-link evidence needs a separately reviewed
source-aware design before those features can be enabled in model context.

### Actual Host inspection and remaining contract work

Read-only inspection of the installed official Desktop archive found
`@deepseek-ai/dsh-desktop-host@0.2.1-rc.3` and
`@deepseek-ai/dsh-session@0.2.1-rc.3`; the repository development dependency
is not sufficient evidence of installed APIs. Session preparation copies
`origin`, `parentSession`, `delegationDepth` and `agentPreset`. Inspection has
not established an immutable ordinary-versus-QQ creator identity contract.
No provenance inference from these fields has been added.

The existing QQ implementation has `storage.isKnownSession()` covering current
and retired bindings. Its public `qq` Host service exposes only positive
Scene resolution and capability checks. Session creation awaits the controller
before binding the returned ID. A future classification contract must address
that creation window and incomplete/lost historical indexes; a missing entry
alone is not enough to certify an ordinary Session. The installed QQ package
was not modified, and no new QQ compatibility version is claimed.

The bounded DSH delegation attempt did not start: after locating the Desktop
CLI, the configured headless Profile was absent. No credentials were copied
and no production Profile was reconfigured.

### Validation and incomplete acceptance

- Quality gate: 753 passed, 0 failed, 0 skipped; focused ACL tests: 28 passed.
- Source/lib synchronization and whitespace validation performed.
- Frozen baseline branch and package hash rechecked; saved SQLite baseline
  files are still present. No new Desktop rollback rehearsal was performed.
- Ordinary Session provenance adapter: **not integrated**.
- Model tools, automatic injection and all event writers: **not integrated**.
- autoSummarize, per-source Dream/Sleep: **not accepted**.
- Five-page GUI permissions and actual ACL graph preview: **not implemented**.
- Migration preview, real Desktop restart/rollback: **not accepted**.
- New 1k/10k end-to-end latency, Host/query counts and model Token costs:
  **not measured**. Earlier performance numbers remain preliminary.

No new LLM calls were introduced by these repairs. This is a code observation,
not a measured model-cost result. The added final per-row check has not yet
been benchmarked. The experiment is still unsuitable to replace the frozen
v1.2.0 baseline; passing this safety checkpoint does not complete phase 2.
