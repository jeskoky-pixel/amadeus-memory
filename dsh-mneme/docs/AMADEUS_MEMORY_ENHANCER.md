# Amadeus Memory Enhancer

This document describes the Amadeus-specific enhancement implemented on branch
`codex/memory-enhancer` on top of the imported Mneme upstream. It is additive:
when the new switches are off, Mneme's existing storage, recall, injection,
dream, sleep, archive, forgetting, scope and mirror behavior is unchanged.

## 1. Scope and switches

| Capability | Switch | Default | Notes |
|---|---|---|---|
| Stable identity / aliases / external IDs / reversible canonical view | always available | — | Additive tables; no automatic linking on startup |
| Preference weights in recall and injection | `memoryPreferenceEnabled` | `false` | Also requires at least one weight other than 1.0 |
| Life trusted own-experience intake | `trustedIntakeEnabled` | `false` | Also requires a configured `apiToken`; request needs explicit scope |

Both switches are in `src/config.js` and the `src/settings.js` feature-flag
whitelist, so the panel can toggle them. There is no LLM call in identity,
preference scoring, or intake validation.

## 2. Stable identity

### 2.1 Tables (idempotent, additive)

All tables are created with `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT
EXISTS` in the same schema open as Mneme. Existing `entities`, `entity_attrs`,
`entity_relations` and `memories` rows are never rewritten by identity code.

| Table | Purpose |
|---|---|
| `entity_external_ids` | Typed identifiers `(platform, entity_type, external_id)`; one active owner per triple |
| `entity_aliases` | Labels with provenance, confidence, confirmation and active state; historical rows retained |
| `entity_canonical_links` | Reversible `entity_id → canonical_id` view links; unique active source |
| `entity_merge_reports` | Persisted dry-run reports; confirmation must reference one |
| `identity_audit_events` | Append-only audit: alias/external/link/report events with payload + evidence |
| `tag_weights` | Tag preference weights in `[0.5, 2.0]` |
| `entity_preference_weights` | Canonical-entity preference weights in `[0.5, 2.0]` |
| `memory_trusted_provenance` | Trusted intake provenance keyed to a memory UUID |

Unique partial indexes enforce the important invariants:

- `UNIQUE(platform, entity_type, external_id) WHERE active = 1` — the same
  trusted identifier can never point at two entities.
- `UNIQUE(entity_id, normalized_alias) WHERE active = 1` — no two active labels
  with the same normalized text on one entity.
- `UNIQUE(normalized_alias) WHERE active = 1 AND confirmed = 1` — a confirmed
  alias cannot point at two canonical groups.
- `UNIQUE(entity_id) WHERE active = 1` on canonical links — one active link per
  source entity (and cycles are rejected by the service).

### 2.2 Legacy migration

Opening an old database runs `seedIdentitySchema`:

- Every legacy entity name becomes an **unconfirmed** alias with provenance
  `legacy_name`. Aliases are labels only; they never trigger a merge.
- Names deterministically matching a QQ-group pattern (`QQ群<id>`,
  `QQ 群 <id>`, `群<id>`, 5–12 digits) seed `platform=qq`,
  `entity_type=group`. This includes legacy rows the old extractor labelled
  `organization` (or `concept`/`technology`/NULL): they are reclassified to
  `group` because the numeric pattern is deterministic. The **previous type is
  preserved** in `identity_audit_events.payload.previous_type` and in the
  external-ID `evidence` (`previous_type`, `entity_name`, `auto_merge:false`).
  A `person`-typed row is never reclassified; the person/group barrier wins.
- The typed triplet is unique. For duplicate legacy rows with the same number,
  one row (first encountered during the migration scan) becomes the active
  typed-ID owner; later rows are reclassified `group` but receive a
  `legacy_qq_group_duplicate` audit event and no competing external-ID row.
  They remain separate nodes and become manual merge candidates through the
  parsed group-number block. No automatic link is made.
- The seed is idempotent: an entity that already has any alias row is skipped on
  later opens, and the QQ-group audit markers prevent re-running the duplicate
  path. An explicit unlink remains unlinked.
- No existing entity UUID, attribute row, relation row, memory row, source or
  weight is modified. Entity `type` may be changed to `group` only through the
  audited deterministic QQ-group rule above; the original value remains in
  audit/evidence.

Migration is performed only when a database is opened. It is **never** run
automatically against production by this branch.

### 2.3 Resolution order

For a write/extraction (`identity.resolveEntityForWrite`):

1. An exact trusted external identifier wins, scoped strictly by the full
   `(platform, entity_type, external_id)` triplet.
2. A **new/unclaimed** external ID creates its own entity and its own typed ID;
   it never inherits an existing name or nickname match. On one platform,
   `qq/person/11111111` and `qq/person/22222222` are different people even when
   both are called "Twin". The same numeric value under another entity type
   (`qq/group/12345` vs `qq/person/12345`) or another platform is a different
   identity and also gets a separate entity. Person/group never merge.
3. With no external ID, an exact **confirmed** alias is explicit human evidence
   and may bind the name to that entity.
4. A bare name alone never binds a person, group, or unknown-type record. If a
   matching candidate exists the call returns `{ok:false,
   reason:"name-only-unresolved"}` (or `ambiguous-entity` for several); the
   extractor records `unresolved` and writes **no** attributes/relations.
   Non-human types (project/concept/technology/organization) retain upstream
   exact-name dedupe when exactly one type-compatible candidate exists.
5. A name with no candidates creates a new entity with an unconfirmed name
   alias. Deterministic QQ group names (`QQ群<id>`, `QQ 群 <id>`, `群<id>`) also
   seed the typed `qq/group/<id>` identifier, so their spelling variants resolve
   to the same group.

Exact trusted IDs take precedence. Same-platform different stable IDs never
merge; cross-platform identities remain separate until an explicit human
dry-run + confirm; person and group remain a hard cross-type barrier. Type
validation is enforced on each entity and the typed triplet stays unique.

Public/open reads resolve only a public entity UUID or the exact public display
name. They never use aliases or typed external IDs (those are only for
authenticated identity routes), so a caller cannot probe whether a private
alias or external ID exists and then read the redacted response. This includes
the open `/search?q=entity:` prefix and the open search's graph-recall fusion:
API calls pass `publicOnly`, which seeds graph recall from public display names
only; model tools and internal retrieval keep full alias resolution.

### 2.4 Canonical view and undo

`entity_canonical_links` is a view layer. `canonicalIdOf` follows active links
transitively. The view is used consistently by:

- entity directory (`GET /entities`) and counts (deduped on canonical UUID);
- ego graph nodes, endpoints, and edge traversal;
- memory-to-entity display (`GET /memories/entities`);
- `entity:` search and graph recall (`findEntitiesMentionedIn`,
  `getLinkedMemoryIds`, neighbors);
- current attributes and aliases/external IDs of a canonical group.

A merge only inserts a link. It does **not** delete entities, rewrite memories,
rewrite `entity_attrs` history, or change relation source/weight. The underlying
member UUIDs remain visible (`member_ids`, `origin_entity_ids`) and historical
attributes remain readable through `GET /identity/history`.

Undo deactivates the link and marks the report undone. It restores the previous
independent view; it never tries to reconstruct deleted data (because none was
deleted). Undo is refused while other active links depend on the link being
undone (`has-dependents`).

### 2.5 Duplicate candidates and human confirmation

A request builds one indexed snapshot (entities, active links, active aliases,
active external IDs — four queries) and groups it in memory. Candidate pairs are
generated through blocking keys: exact normalized name, shared alias, typed
external ID (including parsed QQ-group variants), and a bounded similar-name
trigram path. There is no all-pairs similarity scan, and no arbitrary low entity
cap.

`GET /identity/candidates` proposes pairs from same type, exact/similar
normalized names, shared aliases and shared typed identifiers. It explicitly:

- never links automatically;
- skips pairs whose groups carry different stable IDs for the same
  platform/type (same-platform different IDs stay separate);
- allows same-type cross-platform pairs as candidates, but only an explicit
  human dry-run + confirm can link them;
- reports blockers (`type-boundary`, `alias-conflict`, `cycle`, …);
- says `requires_confirmation: true`.

The human flow is:

1. `POST /identity/merge-preview` → persisted report with counts: linked
   entities, attrs (total/current), relations, memories, attr conflicts,
   relation duplicates, missing memories, blockers, and a deterministic SHA-256
   fingerprint of **all material inputs** (entity/group membership, attrs,
   relations with source/weight, aliases, external IDs, active links, conflicts
   and blockers).
2. `POST /identity/merge` with the `report_id` re-evaluates the same fingerprint
   inside a `BEGIN IMMEDIATE` transaction. A count-stable but material change
   (attr value, relation weight/source, external ID, alias, link, blocker) is
   rejected as `stale-report`; the reviewed report is never applied to
   different inputs. It then inserts the canonical link and marks the report
   applied in the same transaction.
3. `POST /identity/merge-undo` with `link_id` or `report_id` → reversible undo.
   Repeated confirmations are rejected (`report-applied` / `report-undone`).

## 3. Preference weights

Automatic importance (`memories.importance`, 1–5) is untouched.

- Weight range: `0.5 … 2.0` inclusive; default exactly `1.0`.
- Combination: geometric product over every matched tag weight and every
  matched canonical-entity weight. A canonical group contributes at most once
  (strongest member weight).
- Clamp: the factor is clamped to `0.6 … 1.6`, so many tags/entities cannot
  explode or collapse a score.
- Relevance floor: a candidate is only reranked when its fused relevance is at
  least `65%` of the best candidate's relevance.
- Placement: retrieval keeps a larger relevant pool (`max(topK × 8, 60)`, cap
  200) only while the feature is active, then applies the bounded factor before
  the final topK cut, after scope visibility, paused scope, archive, forgetting,
  time bounds, semantic dedup and reranking. Injection applies the same factor
  after type/importance/scope/paused gates and before slot selection.
- Disabled, or every stored weight exactly `1.0`: the legacy fetch limits,
  ranking, slicing and returned row shape are preserved (no `preference` field).

Preference weight never grants permanent retention: archiving/forgetting and
retention tiers still apply, and a weighted row still needs to pass the normal
visibility and relevance gates.

Returned search rows carry `preference: {factor, raw, clamped, applied, tags,
entities, eligible}` (also nested under `signals.preference` when signal
transparency is on). The panel shows the factor, the row's own tags and entity
labels, and whether it was clamped/eligible. No inaccessible memory content is
exposed.

CRUD state is available at `GET /api/dsh-mneme/preferences`; writes are
authenticated `POST` actions (`target=tag|entity`, `action=set|delete`).
`setEntityWeight` clears older member rows and stores one weight for the
canonical group.

## 4. Trusted own-experience intake

Endpoint: `POST /api/dsh-mneme/intake` (JSON, authenticated; no GET).

Enabled only when `trustedIntakeEnabled=true` **and** `apiToken` is configured.
Without a configured token the route returns `503 api-token-required` instead of
failing open.

Minimal request:

```json
{
  "kind": "self_action",
  "status": "completed",
  "participation": "agent",
  "trust_source": "system",
  "actor": "life",
  "title": "补齐了合成测试物料",
  "content": "Life 为合成测试补齐了物料，已确认到位。",
  "scope": { "agent_scope": "amadeus", "workspace_scope": "life" },
  "importance": 3,
  "occurred_at": "2026-10-25T04:00:00Z",
  "evidence": [{ "kind": "receipt", "value": "synthetic-receipt-1" }]
}
```

Rules enforced before any write:

- `kind` ∈ `self_action | direct_interaction | reported_by_other | observation`.
- `status` ∈ `completed | reported`. `planned`, `unconfirmed`, `pending` and
  anything else are rejected. `reported_by_other` requires `reported`; all other
  kinds require `completed`.
- `participation` and `trust_source` must be compatible with `kind` (for
  example, a self action cannot claim to be merely observed, and a report must
  come from `trusted_contact`).
- `scope.agent_scope` and `scope.workspace_scope` must both be explicit strings
  (`global`/`*` means global). Missing scope is rejected.
- `title`/`content`/`actor` are required and length-bounded; `importance` is an
  integer 1–5.
- `evidence` is an array of up to 20 strings/objects.

Writes go through the normal `saveWithDedupe` path (dedupe, quality, importance,
archive/forget, mirror, embeddings, entity extraction), inside one transaction
with the provenance row. This code alone derives deterministic tags:

- `event:self_action`
- `event:direct_interaction`
- `event:reported_by_other`
- `event:observation`

The LLM extractor never derives these tags from casual chat. In addition, the
normal `saveWithDedupe` path strips any `event:*` tag unless
`source=trusted_intake`, so a model calling `memory_save` cannot mint a
completion claim by adding a tag. Provenance is readable at
`GET /api/dsh-mneme/intake/provenance?memoryId=<uuid>`.

Failure semantics:

| Condition | HTTP |
|---|---|
| disabled | `409 disabled` |
| no server `apiToken` | `503 api-token-required` |
| invalid body/status/scope/participant/evidence | `400` with a concrete error code |
| save/provenance failure | `500`; the transaction rolls back |

## 5. API routes and auth policies

Existing conventions are reused (`open` / `token` / `token-write`), and every
route declares a policy explicitly.

**Identity, preference and provenance routes are `token`-gated and require an
actually configured server `apiToken`.** If the server has no token, they return
`503 api-token-required` with a setup message instead of inheriting the legacy
fail-open behavior. The panel shows the same setup state; enter the same token
in Settings → Connections & safety → API Token.

| Route | Method | Policy | Purpose |
|---|---|---|---|
| `/api/dsh-mneme/entities` | GET | open | Canonical entity directory: legacy public fields only, bounded `limit` (≤1000, default 500), `offset`, optional `q` matching **public display names only**; response carries true `total` + `has_more` |
| `/api/dsh-mneme/semantic/graph/ego` | GET | open | Ego graph by public UUID or exact public display name; aliases/external IDs never resolve here |
| `/api/dsh-mneme/semantic/graph/entity-attrs` | GET | open | Current attrs by public UUID or exact public display name; legacy attr fields only |
| `/api/dsh-mneme/memories/entities` | GET | open | Canonicalized `{name,type}` only |
| `/api/dsh-mneme/identity/aliases` | GET/POST | token | List / create / confirm / rename / unlink aliases |
| `/api/dsh-mneme/identity/external-ids` | GET/POST | token | List / bind / confirm / unlink typed external IDs |
| `/api/dsh-mneme/identity/candidates` | GET | token | Proposed duplicate pairs (never auto-link) |
| `/api/dsh-mneme/identity/links` | GET | token | Active / historical canonical links |
| `/api/dsh-mneme/identity/history` | GET | token | Aliases, external IDs, links and audit events |
| `/api/dsh-mneme/identity/entity-detail` | GET | token | Full canonical group + attrs + relation provenance for the panel |
| `/api/dsh-mneme/identity/merge-preview` | POST | token | Persisted dry-run impact report (fingerprinted) |
| `/api/dsh-mneme/identity/merge` | POST | token | Confirm a specific report (stale fingerprint rejected) |
| `/api/dsh-mneme/identity/merge-undo` | POST | token | Reversible undo |
| `/api/dsh-mneme/preferences` | GET/POST | token | Read state / set or delete weights |
| `/api/dsh-mneme/intake` | POST | token | Trusted intake (token mandatory) |
| `/api/dsh-mneme/intake/provenance` | GET | token | Provenance rows for a memory UUID |

Graph reads accept a UUID in `id`; the legacy `entity=<name>` form works only
when the name is the exact public display name and is unique. Aliases and typed
external identifiers are private and resolve only through authenticated identity
routes; an open route cannot be used to probe whether a sensitive alias or
external ID exists. Duplicate names return `{id,name,type}` candidates and
require the UI/API caller to choose a UUID. The open legacy endpoints never
return aliases, external identifiers, evidence, member UUIDs, relation provenance
or per-member attributes; those are only served by `token` routes.

## 6. UI

The hand-authored `lib/client.js` panel is extended in both Chinese and English:

- Settings → Identity & preferences:
  - tag weight CRUD (0.5–2.0),
  - canonical entity weight CRUD,
  - duplicate candidate list,
  - dry-run impact report, confirm, undo,
  - active canonical links.
- Entity/graph view:
  - selects entities by UUID (duplicate names carry an ID suffix),
  - server-paged entity rail (`offset`/`has_more`, optional server-side name/alias
    query) with a “load more” control; the count is the true total, so a
    long-lived graph never silently hides entities beyond the first page,
  - alias add/confirm/rename/unlink,
  - typed external ID bind/unlink,
  - canonical entity preference weight,
  - canonical members and audit history,
  - relation edge weight/source,
  - preference contribution in memory details.
- Feature switches for `memoryPreferenceEnabled` and `trustedIntakeEnabled` live
  in the existing feature card and reuse `--mneme-*` semantic colors.
- Identity/preference/provenance details require the server `apiToken` and the
  same browser token. With no token, those sections show a concise setup state
  instead of silently loading; legacy open graph/directory reads stay usable
  with their redacted shape.

No separate memory manager application is introduced.

## 7. Migration, isolated-profile deployment, rollback

### Migration

- `createStore(path)` runs only additive `CREATE TABLE/INDEX IF NOT EXISTS`
  statements plus the identity seed. It does not link, merge, merge-report, or
  delete anything.
- The seed is idempotent; opening the same database repeatedly does not add
  duplicate alias/external rows.
- Dry-run first: `POST /identity/merge-preview` creates a report and writes no
  link. Only `POST /identity/merge` applies one.
- Back up the SQLite file (and WAL/SHM if present) before any experiment.

### Isolated DSH profile

Use a dedicated profile and an isolated memory directory. Do not point the
development build at the production profile or the production memory directory.
A generic local flow (from the package directory, with the requested profile and
memory directory supplied by the operator):

```bash
dsh plugin --profile <isolated-profile> add "$PWD"
# configure in that profile's cordis.patch.yml:
#   memoryDir: <isolated-memory-dir>
#   apiToken: <test token>
#   trustedIntakeEnabled: true   # only when testing intake
#   memoryPreferenceEnabled: true
```

The production package/profile/database are not installed, switched, or
migrated by this branch.

### Rollback

1. Disable the enhancer switches (or remove the plugin from the isolated
   profile) and restart that isolated DSH.
2. Restore the pre-test database copy if the test requires pristine data.
3. Code rollback: check out the import baseline commit in the development
   checkout. The baseline ignores the additive identity/preference/intake tables.
4. Canonical links are metadata; undo them in the UI/API before rollout if the
   old view must be identical. No memory/attr/relation rows are reconstructed
   because none are deleted.

## 8. Synthetic benchmark

`scripts/benchmark-memory-enhancer.mjs` seeds the same fixture into independent
SQLite files for the import baseline and the implementation, then measures
Recall@5, MRR, p50/p95 search latency, a representative DB LIKE-scan latency,
DB file size and heap delta. No provider/extractor/dream/summarize hook is
installed, so both modes make **0** background LLM calls.

Fixture shape (synthetic, no real data): 4 old important memories, 3 close
birthday events, 3 close weekend events, 6 own actions, 28 casual group-chatter
rows with a clearly fake QQ group number, and 6 irrelevant high-weight rows.

Reproduce (from the package directory; the baseline checkout is generated from
the import commit and is not committed):

```bash
mkdir -p .benchmark/baseline
git -C .. archive --format=tar 13e6520:dsh-mneme | tar -xf - -C .benchmark/baseline
node scripts/benchmark-memory-enhancer.mjs --baseline .benchmark/baseline \
  --runs 3 --iterations 20 --json .benchmark/benchmark-result.json
```

Measured summary (2026-10-25, Node 22, synthetic fixture):

| Metric | Import baseline | Implementation |
|---|---|---|
| Recall@5 | 0.3333 | 0.8492 |
| MRR | 0.3333 | 1.0000 |
| p50 search latency | 3.782 ms | 4.854 ms |
| p95 search latency | 5.217 ms | 7.092 ms |
| DB file size | 344,064 B | 475,136 B |
| Heap delta | 992,859 B | 2,813,715 B |
| Background LLM calls | 0 | 0 |

The latency/size cost comes from the larger preference pool and the additive
identity/preference/intake tables. This is a synthetic benchmark: it does not
model production memory volume, embeddings, reranker models, concurrent writers,
or real query distributions. Recall is only measured on three hand-built
queries.

## 9. Known limitations

- Embedding similarity is not used for identity suggestions; only names,
  aliases and typed IDs are. Similarity alone must never merge.
- Alias confirmation is globally unique per normalized alias. Two people who
  genuinely share a nickname must keep that label unconfirmed (or use distinct
  labels); the UI surfaces the conflict instead of guessing.
- A bare name-only person/group write is unresolved when a candidate exists; use
  a trusted external ID or confirm an alias to bind it. Existing legacy names
  are unconfirmed labels.
- Same-platform different IDs never merge; cross-platform same-type identities
  stay independent until an explicit human dry-run + confirm; person/group never
  merge even across platforms.
- A canonical link chain cannot be undone while dependents exist; undo the
  dependent merge first.
- The preference factor is intentionally small and bounded; it cannot override a
  relevance floor, scope isolation, archive/forget or retention.
- Search by a bare duplicate name returns rows for both candidate groups with no
  guessed canonical attribution; use the UUID/`id` to select one.
- All new identity/preference/provenance routes require an actually configured
  `apiToken`; without one they return `503 api-token-required`. Legacy open
  routes keep their existing behavior and redacted response shape.
- Intake requires an `apiToken`; the legacy panel write routes keep Mneme's
  existing fail-open behavior when no token is configured.
- Legacy organization-typed QQ groups are reclassified to `group` by the
  deterministic numeric rule; the previous type is preserved in audit/evidence
  and duplicate numbers are manual candidates rather than automatic merges.
- The benchmark is synthetic and single-process; it is evidence of direction,
  not a production capacity claim.

## 10. Tests

New/updated tests:

- `test/identity.test.js` — old-schema and organization-typed QQ-group
  migration, entity/attr/relation preservation, typed IDs, aliases
  edit/confirm/unlink/history, same-name collision boundaries, cross-type/
  platform barriers, fingerprint stale-report rejection, reversible merge/undo,
  original-row integrity, 3,000-entity snapshot/query-count and bounded
  candidate blocking.
- `test/memory-enhancer-api.test.js` — route policies, UUID graph reads,
  ambiguous 409, alias/external/history endpoints, merge preview/confirm/undo,
  no-token 503 / unauthenticated 401, legacy open-endpoint redaction,
  preference auth/validation and search DTO explanation.
- `test/preferences.test.js` — CRUD, range validation, clamp, relevance floor,
  off/all-1.0 legacy behavior, topK selection, injection gates.
- `test/memory-enhancer-retrieval.test.js` — synthetic fixture Recall@5/MRR,
  isolation (archive/forget/foreign scope/paused scope), injection, explicit
  entity and graph recall.
- `test/trusted-intake.test.js` — false-completion rejection, missing scope,
  provenance, deterministic tags, normal-save tag stripping, dedupe, route
  auth/disabled/failure semantics.
