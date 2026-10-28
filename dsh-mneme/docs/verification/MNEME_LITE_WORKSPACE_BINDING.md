# Mneme-lite Workspace Binding Verification

Task: `7276cf47-c9b6-4014-a4d0-28213cb2ba76`
Branch: `codex/memory-mneme-lite`

Scope was limited to:

- `dsh-mneme/src/workspace-binding.js`
- `dsh-mneme/test/workspace-binding.test.js`
- `dsh-mneme/docs/verification/MNEME_LITE_WORKSPACE_BINDING.md`

No plugin runtime, routes, configuration, settings, `lib/`, installed package, live
DSH profile, workspace database, or root `memory.db` was modified. This is a
standalone primitive; it is intentionally not wired into the plugin.

## Storage layout

```text
<memoryDir>/
  workspace-binding.json          # control JSON, one stable workspace ID
  workspaces/
    <sha256(workspaceId)>/        # isolated workspace data root
      .mneme-workspace.json       # marker: exact stable workspace ID
  memory.db                       # legacy root DB: never opened or migrated here
```

- `workspace-binding.json` contains only `{ "version": 1, "workspaceId": "..." }`.
  It is outside every workspace DB. An absent file means unbound.
- The workspace directory name is the full SHA-256 hex digest of the stable ID,
  never the raw ID. The raw ID therefore cannot inject path segments.
- The marker contains only `{ "version": 1, "workspaceId": "..." }`. No title,
  path, preset, session ID, or other registry metadata is persisted or returned
  by the storage API.
- No secret is written to either file, and diagnostics never include file
  contents or registry metadata.

## Exported API

### `readWorkspaceBinding(memoryDir)`

Read-only, never throws.

```js
{ bound: true,  workspaceId: "ws-a", diagnostic: null, reason: "ok" }
{ bound: false, workspaceId: null,   diagnostic: "binding-corrupt", reason: "unbound" }
```

Absent file: `diagnostic: null`. Unreadable, invalid JSON, non-object JSON,
unsupported version, or missing/invalid `workspaceId`: unbound with a generic
diagnostic (`binding-unreadable`, `binding-corrupt`,
`binding-unsupported-version`, `binding-missing-workspace-id`). Corrupt data is
never widened to "all workspaces".

### `setWorkspaceBinding({ memoryDir, workspaceId, ctx, beforeRename? })`

Validates `workspaceId` against `listWorkspaces(ctx)` from `workspace-gate.js`.
Only the exact stable registry ID is accepted. Title, directory, preset,
session IDs, caller metadata, and multi-select are never consulted.

```js
// success
{ ok: true, changed: true, oldWorkspaceId: null, newWorkspaceId: "ws-a",
  requestedWorkspaceId: "ws-a", reason: "selected", diagnostic: null }

// already selected (no write)
{ ok: true, changed: false, oldWorkspaceId: "ws-a", newWorkspaceId: "ws-a",
  requestedWorkspaceId: "ws-a", reason: "unchanged", diagnostic: null }

// rejection; active binding is still oldWorkspaceId
{ ok: false, changed: false, oldWorkspaceId: "ws-a", newWorkspaceId: "ws-a",
  requestedWorkspaceId: "ws-x", reason: "unknown-workspace-id", diagnostic: null }
```

Failure reasons: `invalid-memory-dir`, `invalid-workspace-id`,
`unknown-workspace-id`, `write-failed`. On every failure `newWorkspaceId` is
the still-active old binding, so the return value cannot claim a change that did
not happen. `requestedWorkspaceId` keeps the rejected request visible.

`beforeRename` is a test-only crash-injection hook. The temporary file is
created in the same directory with mode `0600`, written, `fsync`ed, then
atomically renamed over the control file. A failure before the rename removes
the temp file and leaves the previous control file byte-for-byte intact.

### `unbindWorkspace({ memoryDir })`

Explicit unbind is separate from selection.

```js
{ ok: true, changed: true,  oldWorkspaceId: "ws-a", newWorkspaceId: null,
  requestedWorkspaceId: null, reason: "unbound", diagnostic: null }
{ ok: true, changed: false, oldWorkspaceId: null, newWorkspaceId: null,
  requestedWorkspaceId: null, reason: "already-unbound", diagnostic: null }
```

It removes only `workspace-binding.json`; workspace data is not deleted
implicitly. A removal failure returns `ok: false, reason: "unbind-failed"` and
leaves the old binding in place. Bad selection input always returns `ok: false`,
so the two paths are distinguishable.

### `workspaceDataDirFor(memoryDir, workspaceId)`

Pure path derivation (no filesystem access, no creation). Returns
`<memoryDir>/workspaces/<sha256(workspaceId)>` or `null` for invalid input. The
resolved path is checked to be inside `<memoryDir>/workspaces`.

### `resolveWorkspaceDataDir(memoryDir, workspaceId?)`

Read-only. Without an explicit ID it resolves the currently persisted binding;
an unbound or invalid binding fails and creates nothing. It returns the derived
path plus `exists` and `initialized`, and never creates a directory.

```js
{ ok: true, workspaceId, path, exists: false, initialized: false, reason: "absent", diagnostic: null }
{ ok: true, workspaceId, path, exists: true,  initialized: true,  reason: "ok", diagnostic: null }
```

Rejections (`ok: false`): `unbound`, `invalid-memory-dir`,
`invalid-workspace-id`, `unsafe-data-path`, `data-path-not-directory`,
`data-path-unreadable`, `marker-mismatch`, `marker-corrupt`,
`marker-unsupported-version`, `marker-missing-workspace-id`,
`marker-not-a-file`, `marker-unreadable`, `unmarked-legacy-directory`.

A populated directory without a marker is treated as a legacy directory and is
rejected, not adopted or migrated. An empty directory without a marker is
reported as `empty-uninitialized` and may be initialized explicitly. A marker
whose exact `workspaceId` differs from the derived ID is rejected.

### `initializeWorkspaceDataDir(memoryDir, { beforeRename? })`

The only path that creates `<memoryDir>/workspaces/<digest>`. It requires an
existing persisted selection, so it cannot create workspace data for an unbound
state. It refuses marker mismatches and non-empty unmarked directories, creates
the directory if absent, and writes the marker atomically. It returns
`created: true` only when the directory itself was newly created. It never
creates or opens a database.

## Tests

Command (from `dsh-mneme/`):

```text
node test/workspace-binding.test.js
```

The file uses `node:test`. It is executed directly because the sandbox rejects
the `node --test` runner's child-process spawn with `EPERM`; direct execution
runs the same `node:test` cases in-process.

Result:

```text
1..12
# tests 12
# pass 12
# fail 0
```

Coverage includes:

- absent binding is unbound and creates nothing (including read-only resolution
  and unbound initialization)
- corrupt JSON, non-object JSON, unsupported version, and missing ID read as
  unbound with the expected diagnostic, never as all-workspaces
- valid selection persists exactly one ID, stores no title/path/preset/session
  metadata, and is idempotent
- unknown ID, title, path, preset, empty/whitespace, non-string, and object input
  are rejected while the prior binding and file bytes stay unchanged
- same-title workspaces with different stable IDs select independently
- selection survives a fresh module instance (restart persistence)
- atomic write failure (injected before rename) preserves the prior binding,
  removes the temp file, and a first-ever failed write stays unbound
- hostile and traversal-shaped IDs are SHA-256 digested; derived paths remain
  direct children of `<memoryDir>/workspaces` and no escaped path is created
- marker mismatch, corrupt marker, unsupported marker version, and non-empty
  unmarked legacy directories are rejected; empty unmarked directories can be
  initialized after explicit selection
- an existing root `memory.db` stays byte-identical and no root DB/WAL/SHM is
  created; a clean memoryDir gains only the control file and `workspaces/`
- two workspaces have separate paths, markers, and database files, and can be
  reselected without leaking data between them
- explicit unbind is distinguishable from rejected input and does not delete
  workspace data implicitly

All tests use `os.tmpdir()` temporary directories.

## Unresolved runtime rebinding concern

This module persists a selection and defines isolated paths, but it does **not**
make live Workspace switching work. In particular:

1. The plugin runtime is not wired to this module. Selecting a new workspace ID
   will not move an already-open store, service, vector index, or background
   job from the old database.
2. The store/plugin lifecycle must be coordinated by the integration owner:
   selection must happen while the relevant workspace store is closed, or the
   runtime must reopen/recreate it after the binding change. Process restart is
   the simplest safe boundary. A live hot-swap is not solved or claimed here.
3. `<memoryDir>/memory.db` is deliberately untouched. Existing installations
   remain on the legacy root DB until an explicit, audited migration is designed;
   this module provides neither automatic detection nor migration.
4. `dsh-mneme/lib/` was not regenerated because it is outside the owned paths.
   The integration owner must run `npm run sync` after wiring this source, then
   run the relevant quality/tests.
5. The registry shape comes from the existing `listWorkspaces()` contract:
   `{ id, title, sessionCount }` with no session IDs or paths. It was not
   validated against a live DSH registry in this task.

## Contract check

- [x] Exactly one stable Workspace ID persisted in control JSON under `memoryDir`
- [x] Absent = unbound; corrupt/unsupported = unbound with diagnostic, never all
- [x] Same-directory temp, `fsync`, atomic rename; old binding preserved on failure
- [x] Setter accepts only an ID present in the live trusted registry via `listWorkspaces`
- [x] No free-form title/path/preset and no multi-select; old/new IDs and changed flag returned
- [x] Explicit unbind is distinguishable from bad input
- [x] Data directory derived from SHA-256 digest, contained under `memoryDir/workspaces`
- [x] Exact-ID marker; mismatched marker and non-empty unmarked legacy directory rejected
- [x] No automatic root `memory.db` open, creation, or migration
- [x] Read-only resolution and unbound state create no data directory
- [x] Initialization requires a prior explicit selection
- [x] All requested test cases pass using temp directories only
- [x] No web search, external agents, child agents, commit, or scope expansion
- [x] Verification report written, including the unresolved runtime concern
