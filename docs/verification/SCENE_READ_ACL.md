# Scene read ACL and owner explorer boundary

## Model read policy

- Ordinary QQ group: reads only its own group's active long-term memories.
- Ordinary QQ private scene: reads only its own private scene.
- Verified Host-minted owner-private scene: reads all Scenes, including legacy
  untagged rows. This is a capability from the in-process QQ Host, not from
  `agentPreset`, tool arguments, HTTP parameters or a plain `{admin:true}`.
- Manual group grant: reader group may read the selected source group's
  **persisted long-term memories and evidence** only. Grants are directional,
  read-only, non-transitive, same-bot, and never include private scenes or
  legacy rows.
- Recent Context and Session hot memory are **not** widened by the group
  allowlist. Non-owner groups keep raw ephemeral text bound to their own trusted
  Scene; only the owner-private capability reads all Recent Scenes.
- Model `scenes` arguments on `memory_search`/`memory_list` only narrow the
  server-computed readable set. Omitted means the ACL default. Unknown or
  ungranted names yield no rows; owner read-all does not grant writes.
- Model mutation authorization is exact-Scene: update/archive/delete stay in the
  current trusted Scene. The owner browser management routes are a separate
  explicit admin authority used by the owner explorer.

## Persistence and migration

Additive table `scene_read_grants`:

- primary key `(reader_scene, source_scene)` (unique directional pair)
- `created_at`, `created_by`, `note`
- `CREATE TABLE IF NOT EXISTS`; no memory-row rewrite, so old libraries are safe.
- Grant/revoke run in transactions. `store.listSceneReadGrants()` is bounded to
  500 rows.

Rollback: revoke grants through the UI/API first; then dropping
`scene_read_grants` only removes ACL metadata and leaves all memory rows intact.
No memory, Scene attribution or audit history is modified by migration rollback.

## Owner GUI and API

Owner-authenticated same-origin admin routes:

- `GET /acl` — groups suggestions, grants, policy labels.
- `POST /acl/grant` / `/acl/revoke` — accepts canonical same-bot group Scenes or
  `{bot, reader_group, source_group}` numeric group IDs. The client derives the
  bot from known QQ Scenes only when exactly one bot is known; otherwise the
  operator enters it explicitly.
- `GET /memories?scenes=all|id,id` and `GET /graph?scopes=all|id,id` — owner
  selection only; graph merges evidence by stable entity ID and never infers
  identity merges.
- `GET /status` — bounded overview, real LLM audit totals/day rows, dream runs,
  conflict count.
- `GET /personalization` / `POST /personalization/profile` /
  `POST /personalization/persona` — owner-only profile/persona read/write and the
  actual server-rendered injection preview under strict Scene. Ordinary
  `/api/dsh-mneme/profile` and `/persona` routes are unchanged and remain denied
  by the strict ordinary-route policy.

Browser all/multi/one selection is a UI read filter, not an ACL mutation. The
manual allowlist is the only browser action that changes model readability.

## Optional cross-plugin handshake

A running strict instance provides the synchronous Cordis service
`amadeus.memory` with `sceneAclRead()`:

```js
{
  contract: "amadeus-memory/trusted-scene-acl-read",
  version: 1,
  trustedSceneAcl: true,
  strictQQ: true,
  tools: ["memory_search", "memory_list", "memory_get"]
}
```

It returns this declaration only when the running config has both
`sceneIsolationEnabled` and `sceneStrictQQ` true and the in-process QQ Host
`resolveTrustedSessionScene` entry is present; otherwise it returns `null`.
The service is registered with `ctx.provide("amadeus.memory", ...)`, removed on
plugin unload, and is not exposed through model tools, HTTP or ordinary APIs.
Cordis 4 accepts this dotted service name; this was verified with a real
`Context.provide`/`reflect.get`/dispose test.

## Known limits

- The QQ Host binding is the authority. A session with no resolvable Host Scene
  fails closed for known QQ presets; unknown non-QQ presets keep legacy behavior.
- `memory_list` applies the allowed Scene set in SQL before LIMIT/OFFSET and
  computes `total` with the same SQL filters. `memory_search` keyword SQL and
  vector/BM25 candidate SQL receive the same filter before their bounded LIMIT.
- Owner explicit Scene selection is an SQL filter; owner default (all) omits the
  filter so legacy rows remain visible. Ordinary groups build the set from their
  own canonical Scene plus persisted grants for that exact reader; they never
  derive it from the most numerous Scenes in the database.
- Admin `/memories` keyword and list paths apply Scene/type/importance/date and
  archived-only filters in SQL before LIMIT.
- Graph output is bounded (100 nodes / 200 edges per scope, merged caps) and
  explicit `truncated`.
- `entityRecall` and `entity:`/`attr:` helper searches still post-filter their
  linked-memory candidates after retrieval; keyword/list and vector/BM25 paths
  have SQL Scene filtering before LIMIT. This remains a reported limitation.
- Manual grants do not cover raw Recent/hot-memory text.
