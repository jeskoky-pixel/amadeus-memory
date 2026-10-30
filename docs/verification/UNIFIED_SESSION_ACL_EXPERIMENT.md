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
- Experimental branch quality gate at this checkpoint: 737 passed, 0 failed,
  0 skipped. This only validates the implemented foundation, not the full
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
   membership and QQ Scene at every model invocation. Never trust HTTP or tool
   arguments for source identity.
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

The standalone ACL core and synthetic tests cover trusted identity, QQ rebuild,
legacy quarantine, source-conjunctive reads, directional grants, Owner policy,
revocation, schema reopen, and write rollback. Within a trusted execution
context, the Mneme store now stamps a source and filters list, keyword, vector,
count, and direct-ID lookups before candidate limits. The context is not yet
connected to DSH model execution, and graph aliases/relations, GUI, and
Dream/Sleep have not been safely integrated. Therefore the unified architecture
has **not** met the acceptance standard and cannot replace the baseline.
