# Mneme-lite Workspace Admin API Verification

Task: `4e1b8f51-0785-49f5-b8f4-2f582c7f644a`
Branch: `codex/memory-mneme-lite`

Scope was limited to the owned paths:

- `dsh-mneme/src/admin-api.js`
- `dsh-mneme/src/index.js`
- `dsh-mneme/test/admin-workspace.test.js`
- `dsh-mneme/docs/verification/MNEME_LITE_WORKSPACE_ADMIN.md`
- synced `dsh-mneme/lib/admin-api.js` and `dsh-mneme/lib/index.js`

No GUI, web search, child agent, commit, installed package, live DSH profile,
database migration or production data was touched.

## API

Both methods use the existing `/api/amadeus-memory/admin` owner gate:
`connection.admit(req)` must resolve to `peer.principal.kind === "owner"`, the
request must be same-origin, and POST must carry `x-amadeus-memory: 1`.

### `GET /api/amadeus-memory/admin/workspace`

Returns only ID/title/count metadata from `listWorkspaces(ctx)` plus binding
state. Session IDs, session headers and database/control-root paths are never
returned.

```json
{
  "ok": true,
  "data": {
    "workspaces": [
      { "id": "stable-workspace-id", "title": "Display title", "session_count": 3 }
    ],
    "selected_workspace_id": "stable-workspace-id",
    "active_workspace_id": "stable-workspace-id",
    "runtime_mode": "selected",
    "pending_remount": false,
    "restart_required": false,
    "registry_available": true,
    "remount": {
      "supported": false,
      "reason": "host-loader-update-requires-effective-option-change",
      "action": "restart-plugin"
    }
  }
}
```

`selected_workspace_id` is read live from `workspace-binding.json` at the
configured control root. `active_workspace_id` is the boot-time runtime ID.
`pending_remount` is true whenever those differ, including a newly selected
binding while the old runtime is still mounted, a binding that appeared while
the runtime booted unbound, or a binding changed relative to boot. It remains
true when a selection is changed back to the boot-time ID, because the mounted
runtime guard latched on the first mismatch and still requires a remount.
Missing/invalid Registry data is reported as `registry_available: false` with a
stable `registry_error`; it is not presented as an empty valid Registry.

### `POST /api/amadeus-memory/admin/workspace`

```json
{ "workspace_id": "<exact stable Registry ID>", "confirm": true }
```

- `workspace_id` must be a string that exactly equals a live Registry `id`.
  Titles, paths, Presets and session fields are never consulted. A title that
  matches a Workspace name is rejected as `unknown-workspace-id`.
- `confirm: true` is required only when the requested ID differs from the
  persisted selection. Selecting the same ID is a confirmation-free no-op.
- The API calls `setWorkspaceBinding({ memoryDir: controlRoot, workspaceId,
  ctx })`, not `memoryDir` set to the active Workspace data directory.
- An unavailable/malformed Registry returns `503` before the setter; an unknown
  or non-exact ID returns `400`; a write failure returns `409`. In every failure
  path the existing binding is left unchanged.
- A successful change returns `changed`, `old_workspace_id`, the live snapshot,
  `pending_remount: true`, `restart_required: true` and a restart message. It
  never reports the new Workspace as the active runtime.

## Host loader investigation

Local host source inspected (no web search):

- `lite-host-source/dsh/node_modules/@deepseek-ai/cordis-plugin-loader`
  (`1.0.6`), `src/index.ts`, `src/config/tree.ts`, `src/config/entry.ts`
- `lite-host-source/dsh/node_modules/@deepseek-ai/cordis/src/fiber.ts`
- `lite-host-source/dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js`

Findings:

1. `loader.locate(fiber)` (`src/index.ts`) can establish the current plugin
   entry ID from the loader's own fiber/entry association, and
   `loader.resolve(id).options` exposes that entry's options. The current entry
   can therefore be identified without guessing or scanning other entries.
2. `loader.update(id, options)` (`src/config/tree.ts`) delegates to
   `entry.update(options, false, true)`. `Entry.update()` only reaches
   `fiber.update(config, true)` through `_patchContext()` when an effective
   option changed, and `_patchContext()` remounts only when `config` changed or
   the entry is a group. With unchanged options the forced call settles with an
   empty diff and does **not** restart the plugin.
3. `Fiber.restart()` exists in Cordis, but the loader exposes no
   `loader.update` option that calls it unconditionally. The host plugin
   manager performs live reloads through its HMR/profile recompose path, not
   through a plugin-callable entry-restart API.
4. Toggling `entry.options.disabled` through `loader.update()` would force an
   unmount and a later re-init, but that is a two-step lifecycle with a window
   where the owner API and all memory routes are gone. If the re-init failed,
   the plugin would remain unloaded. That is not a safe remount for this
   milestone.

Therefore automatic remount is not implemented. The API truthfully reports
`pending_remount: true` / `restart_required: true` and
`remount.supported: false`, and requires a host plugin restart (or host-level
plugin reload) to adopt the new Workspace. The old runtime guard reads the
binding file on every model boundary and immediately denies with
`binding-changed-pending-remount`, so model work cannot continue against the
old store in the meantime.

## Runtime wiring and safety properties

`index.js` now passes the control root separately from the runtime data root to
`mountAdminApi`:

```js
controlRoot: workspaceRuntime.controlRoot,
activeWorkspaceId,
initialSelectedWorkspaceId: workspaceRuntime.binding?.workspaceId ?? null
```

The existing `memoryDir` dependency remains the active runtime directory for
backup/restore endpoints, so those routes still operate on the mounted
Workspace store. The Workspace selection endpoint always writes at the control
root.

- First installation with no binding: the plugin boots its separate unbound
  control database and still mounts the owner admin route. The full-boot test
  verifies `GET` and `POST` work there and that `memory.db` at the legacy
  control root is never created.
- A binding change writes only `workspace-binding.json`. It does not initialize
  the selected Workspace directory, open a database, restore, migrate, or
  delete any old data. The selected Workspace store is only opened on the next
  plugin mount.
- The old runtime guard is not reset by the API. After a change it refuses
  model tools, prompt injection, autoSummarize and the other gated hooks.
- Existing owner routes/pages were not removed or renamed.

## Tests

Commands run from `dsh-mneme/` (file-by-file because this sandbox blocks the
Node test runner's child-process spawn):

```text
node test/admin-workspace.test.js
node test/memory-admin-api.test.js
node test/memory-management-api.test.js
node test/workspace-runtime.test.js
node test/lib-smoke.test.js
node scripts/check-sync.js
```

Results:

```text
admin-workspace.test.js          9 tests,  9 pass, 0 fail
memory-admin-api.test.js         6 tests,  6 pass, 0 fail
memory-management-api.test.js   17 tests, 17 pass, 0 fail
workspace-runtime.test.js       13 tests, 13 pass, 0 fail
lib-smoke.test.js                6 tests,  6 pass, 0 fail
check-sync                      ✓ src/ 与 lib/ 一致（90 个文件）
```

The new suite covers GET metadata without paths or session IDs, live Registry
refresh, first-install unbound boot, exact-ID selection, confirmation,
invalid/unavailable/malformed Registry without binding mutation, owner auth,
same-origin, request marker, same-ID no-op, persistence across a new mount,
immediate stale-runtime denial, change-back latch (still pending), retained
legacy database, and no workspace data initialization/migration.

## Unresolved limitations

- No automatic remount: a host plugin restart is required after a selection
  change. `pending_remount`/`restart_required` are stable API fields for the
  later GUI.
- No unbind endpoint was added; `unbindWorkspace()` remains available to the
  binding module but is outside this task's requested API.
- The GUI is intentionally untouched.
- This report does not claim live Desktop acceptance of the restart path; it
  verifies the API, binding write, stale-runtime denial and full unbound boot.

## Contract check

- [x] GET lists live Registry workspaces by stable ID with title and session
      count; selected, active and pending-remount state are included
- [x] Titles, paths and Presets are never used for authorization; no paths or
      session IDs are exposed
- [x] POST requires an exact Registry ID and confirmation for a change, uses
      the control root and `setWorkspaceBinding`, and never mutates on
      invalid/unavailable Registry
- [x] Owner `connection.admit(req)`, same-origin and request-marker checks apply
- [x] A change immediately makes the old runtime guard deny model work; the old
      database is retained and no migration occurs
- [x] Local host loader API investigated; safe automatic remount unavailable,
      so pending/restart state is returned truthfully
- [x] First installation without a binding still mounts the owner API
- [x] Tests use an isolated temp root and fake trusted Registry/connection
- [x] Focused tests pass, `npm run sync` ran, src/lib parity confirmed
- [x] No web search, external agents, child agents, commit or scope expansion
