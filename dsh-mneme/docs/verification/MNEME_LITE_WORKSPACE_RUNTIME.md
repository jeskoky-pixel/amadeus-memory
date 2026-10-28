# Mneme-lite Workspace Runtime Verification

Task: `43fd8092-c658-49ec-8490-763b39f55621`
Branch: `codex/memory-mneme-lite`

Owned implementation paths changed:

- `dsh-mneme/src/index.js`
- `dsh-mneme/src/tools.js`
- `dsh-mneme/src/inject.js`
- `dsh-mneme/src/summarize.js`
- `dsh-mneme/src/workspace-binding.js` (access guard + unbound directory constant)
- `dsh-mneme/lib/` corresponding sync outputs
- `dsh-mneme/test/workspace-runtime.test.js`

`src/workspace-gate.js`, `test/workspace-gate.test.js`, `test/workspace-binding.test.js`,
GUI, API route files, package metadata, installed files and profiles were not edited.

## Boot and storage layout

`memoryDir` is the control root. The only binding input is
`<memoryDir>/workspace-binding.json` from the reviewed binding module.

```text
<memoryDir>/                          # control root; never a database root
  workspace-binding.json             # one stable Workspace ID
  memory.db                          # legacy root DB: never opened/created/restored/migrated
  unbound/memory.db                  # separate owner-GUI control DB when unbound
  workspaces/<sha256(workspaceId)>/  # selected isolated runtime
    .mneme-workspace.json
    memory.db
    documents/  backups/  ...        # scoped runtime file state
```

- Selected mode: `resolveWorkspaceRuntime()` calls `initializeWorkspaceDataDir()` and
  opens only the digest-derived `workspaces/<digest>/memory.db`. A marker mismatch,
  corrupt binding or absent binding falls back to `unbound/memory.db`; a mismatched
  workspace directory is never adopted, rewritten or migrated.
- Unbound mode: the owner GUI can load its separate control database, but no model
  memory operation is authorized. Boot logs the reason and the guard denies. If a
  legacy root `memory.db` exists, boot only logs that it was ignored.
- Staged restores are applied only to the selected isolated runtime, before the store
  is opened. Unbound mode skips restores so its control database stays separate.
- No binding/config key, GUI selector or loader restart was added. Selection and
  remount remain an operator/later-UI action.

## Authorization boundaries

`createWorkspaceAccessGuard()` (in `workspace-binding.js`) is created once per mount
with the control root, the active store's Workspace ID and the trusted `ctx`. On every
call it:

1. re-reads the binding file;
2. requires the binding ID to still equal the active store's Workspace ID;
3. calls `checkWorkspaceAccess(trustedSession, activeWorkspaceId, ctx)` (registry read
   fresh, missing/invalid registry denies);
4. latches any binding mismatch/unbind, so switching away and back still denies until
   a remount.

`index.js` always supplies this callback:

- `createTools(..., authorizeModelWork)` wraps every registered tool, including
  read-only `memory_list` / `memory_get`, before any service read. The session comes
  only from `exec.agent.session`; arguments are never consulted.
- `createInjector(..., gate, authorizeModelWork)` gates both the memory context and
  the user-settings context before Hot Memory extraction, query prefetch, retrieval
  or preview snapshot updates. Unauthorized renders return `""`.
- `createSummarizer(..., { authorizeModelWork })` checks at the `turn/end` entry,
  again before the summary transaction, again inside the transaction and before the
  empty-window cursor write. Async LLM work therefore cannot commit after a mid-flight
  binding switch.

Direct module tests that omit the callback retain the legacy allow behavior. Only the
mounted runtime supplies it.

## Scoped file state and autonomous jobs

- Mirror, managed documents, document index, admin backups and staged restores use
  `runtimeDir` (selected Workspace directory or `unbound/`).
- A live scoped config proxy overrides `memoryDir` to `runtimeDir` for the service,
  engine, semantic, API and admin consumers. This also scopes candidate/observation
  paths read inside the panel API.
- A configured absolute/`~` `documentDir` is ignored with a warning; a relative value
  resolves under `runtimeDir`.
- Unbound mode does not mount Dream, Sleep, entity extraction, continuity rescue or
  action-nudge proposal writes; the semantic boot backfill is also overridden off.
  Selected mode mounts Dream/Sleep against the isolated store and scoped config only.
- The standalone external API is disabled in this milestone with a clear log: it
  cannot assert a trusted DSH Session, so its model memory data plane would be a
  bypass. Owner panel/API routes remain mounted.

## Tests

Focused commands (from `dsh-mneme/`), all using temp directories:

```text
node test/workspace-runtime.test.js     # 13 pass
node test/workspace-gate.test.js        # 15 pass
node test/workspace-binding.test.js     # 12 pass
node test/tools.test.js                 # 32 pass
node test/inject.test.js                # 30 pass
node test/lifecycle-productization.test.js  # 1 pass
node test/webServer-optional.test.js    # 4 pass
node test/lib-smoke.test.js             # 6 pass
node scripts/check-sync.js              # 89 files, src/lib identical
```

`workspace-runtime.test.js` covers no-selection boot, selected boot with isolated
store, old root DB byte-identical and no root DB creation, corrupt binding, marker
mismatch, authorized/unauthorized tool and injector, summary event gating, moved
Session, binding change pending remount (including switch-back), mid-flight binding
switch before the summary transaction, scoped config, and a full cordis plugin boot
asserting the isolated DB path plus the wired tool gate.

Known legacy incompatibility (honest gap): `test/summarize.test.js` has two
full-boot tests (`distill records grow from the settings face all the way to disk`,
`the same assembly writes nothing when the flag was never set`) that seed
`<memoryDir>/memory.db` and expect unbound boot to use it. The new security contract
intentionally uses `<memoryDir>/unbound/memory.db` and never opens the root DB, so
those two tests fail (`82/84` pass). They are outside this task's owned paths and need
a follow-up test update, not a source relaxation.

## Remaining gaps

1. **No live rebinding event/GUI wiring.** `loader.update(id, options)` is not called;
   the UI switch is a later task. A binding change makes the old runtime deny
   immediately and requires a process/plugin remount to adopt the new store.
2. **Continuity and action-nudge hooks are not session-gated in selected mode.**
   They are outside the owned source paths. They are disabled entirely in unbound
   mode. A selected-runtime session from another Workspace could still cause those
   hooks to write into the selected store; this should be gated in their own module.
3. **Legacy root DB is deliberately not migrated.** Existing installations with only
   `<memoryDir>/memory.db` boot into unbound mode until an explicit, audited migration
   or Workspace selection/remount is performed.
4. **Legacy full-boot tests need updating** as described above.
5. No live DSH Workspace Registry was exercised; the reviewed gate contract
   (`list()` with stable `id`/`title`/`sessionIds`) is assumed.
6. The standalone external API is disabled entirely rather than selectively failing
   individual routes.

## Contract check

- [x] Plugin boot never opens/creates/restores/migrates the legacy root DB; selected
      boot uses only the digest-derived isolated store.
- [x] Unbound boot uses `controlRoot/unbound` for owner GUI while denying all model work.
- [x] Every registered tool, prompt injection and autoSummarize event requires the
      binding match and fresh `checkWorkspaceAccess`; missing/invalid registry denies.
- [x] Binding change denies the old runtime immediately (latched until remount).
- [x] Summary recheck occurs after async LLM work and before the DB transaction.
- [x] Direct module tests without a callback keep legacy defaults; index.js always
      supplies the callback.
- [x] Runtime file state uses the active Workspace root; global absolute documentDir
      is not adopted.
- [x] Unbound mode schedules no autonomous memory writes; selected Dream/Sleep use the
      isolated DB.
- [x] Standalone external API model data plane is disabled with a log; owner GUI/API
      remains mounted.
- [x] Focused tests pass; src/lib parity checked after `npm run sync`.
- [x] No web search, external agents, child agents, commits or scope expansion.
