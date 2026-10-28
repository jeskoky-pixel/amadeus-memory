# Mneme-lite Workspace Gate Verification

Task: `dee4022b-0343-4ad9-8bc0-2faf7ce98ca6`
Branch: `codex/memory-mneme-lite`

Scope was limited to:

- `dsh-mneme/src/workspace-gate.js`
- `dsh-mneme/test/workspace-gate.test.js`
- `dsh-mneme/docs/verification/MNEME_LITE_WORKSPACE_GATE.md`

No production files, installed packages, package metadata, `index.js`, GUI, existing
engine files, database code, or live DSH profile were modified.

## Exported API

### `listWorkspaces(ctx)`

Returns normalized workspaces from the trusted `workspaceRegistry` service:

```js
[
  { id: "workspace-stable-id", title: "Workspace title", sessionCount: 2 }
]
```

- In Cordis contexts the service is read through `ctx.reflect.get("workspaceRegistry")`.
- Plain mock/older contexts without `reflect.get` use the ordinary `ctx.workspaceRegistry` property.
- Missing registry, missing `list()`, a thrown registry accessor, or a non-array result
  returns `[]`. A throwing per-entry getter marks that entry malformed; the entry is omitted.
- Only validated non-empty string IDs and arrays of non-empty string session IDs
  are required. A missing, blank, or throwing display title falls back to the stable ID.
- Malformed entries are omitted. Workspaces sharing a duplicate stable ID are omitted.
- Output never includes session IDs, paths, presets, or other registry fields.

### `checkWorkspaceAccess(session, selectedWorkspaceId, ctx)`

Per-request allow/deny result:

```js
{ allowed: true,  reason: "ok", workspaceId: "workspace-stable-id" }
{ allowed: false, reason: "workspace-mismatch", workspaceId: null }
```

Allow requires all of the following:

1. `session.id` is a non-empty stable string.
2. `selectedWorkspaceId` is a non-empty stable string.
3. The registry is readable and contains no malformed identity/membership entries or duplicate workspace IDs.
4. The session ID appears in exactly one registry workspace.
5. That workspace's stable `id` exactly equals the selected workspace ID.

The registry is queried afresh on every call. Nothing is cached, so newly added and
moved sessions take effect on the next request.

Deny reasons: `missing-workspace-id`, `missing-session-id`, `registry-unavailable`,
`malformed-registry`, `ambiguous-registry`, `session-not-found`,
`ambiguous-membership`, `workspace-mismatch`.

## Trust and fail-closed decisions

- Authorization reads only `session.id`, `workspace.id`, and `workspace.sessionIds`.
- Titles, directories/paths, presets, session headers, caller JSON, request fields, and
  any other caller-controlled metadata are never used to authorize.
- All service, identity/membership, and session property reads are guarded; thrown
  identity or membership getters deny. A title getter only affects display.
- Duplicate workspace IDs and any malformed registry entry make the authorization path
  deny globally for that request rather than silently skipping unreadable data.
- No side effects, no mutations, no caching, and no database operations.

## Tests

Command (from `dsh-mneme/`):

```text
node test/workspace-gate.test.js
```

The file uses `node:test`. It was executed directly because this sandbox rejects the
`node --test` runner's child-process spawn with `EPERM`; direct execution runs the same
`node:test` cases in-process.

Result:

```text
1..15
# tests 15
# pass 15
# fail 0
# duration_ms 11.296
```

Coverage includes:

- validated list output, including `reflect.get` and plain mock contexts
- selected workspace allows an exact stable session ID
- unselected workspace denies; same title with a different workspace ID denies
- newly added session takes effect on the next request
- moved session is denied by the old workspace and allowed by the new one
- forged session title, workspace fields, directory, preset, header, and caller JSON
  never authorize; a session whose metadata getters throw still authorizes correctly
  from its stable `id` alone
- missing selected ID, missing session ID, absent registry, and stale session deny
- ambiguous membership across two workspaces denies
- non-array registry data, malformed entries, and duplicate workspace IDs fail closed
- registry exceptions, `reflect.get` exceptions, and throwing identity/membership/session getters deny
- blank or throwing display titles fall back to stable IDs and do not revoke valid membership
- reads do not mutate frozen registry data

## Unresolved integration concerns

1. This is a standalone module. It is intentionally not wired into `index.js`, routes,
   configuration, settings, GUI, or engine behavior because those paths are outside the
   owned scope.
2. `dsh-mneme/lib/` was not regenerated. Running `npm run sync` would create or modify
   `dsh-mneme/lib/workspace-gate.js`, which is outside the allowed paths. The integration
   owner must run the sync after wiring the module.
3. The registry shape assumption is `workspaceRegistry.list()` returning workspace
   wrappers that expose stable `id`, `title`, and `sessionIds` (the shape already used by
   the existing scope resolver). It was not verified against a live registry in this task.
   A missing title uses the stable ID as a display fallback.
4. The selected single workspace ID must come from trusted configuration. This task does
   not add a config key or feature flag because `src/config.js` and `src/settings.js` are
   outside scope.
5. The fail-closed policy is global: one malformed entry or duplicate workspace ID denies
   every membership request while that registry state persists. This is deliberate, but
   observability should be added before production use.
6. No API route, API policy, or route test was added because the task is limited to the
   standalone gate.

## Contract check

- [x] Real workspaces listed from the trusted registry with validated stable fields
- [x] Exact per-request stable-ID membership check
- [x] Missing, forged, stale, moved, malformed, ambiguous, and thrown cases deny
- [x] New/moved sessions observed because the registry is read fresh each call
- [x] Meaningful `node:test` coverage; only the new test was run
- [x] No web search, external agents, child agents, commit, or scope expansion
- [x] Verification report written
